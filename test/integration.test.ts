import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { serve } from "../src/broker.js";
import { Bridge } from "../src/bridge.js";
import type { Config } from "../src/config.js";

function temporary(t: any) {
  const dir = mkdtempSync(join(tmpdir(), "lb-ipc-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const message = {
  schema: "2.0",
  header: { event_id: "evt", event_type: "im.message.receive_v1" },
  event: { message: { chat_id: "oc_chat", content: "你好" } },
};
test("Unix socket RPC registers sessions, routes, claims, acknowledges and rejects duplicate sessions", async (t) => {
  const dir = temporary(t);
  const cfg: Config = {
    appId: "offline",
    stateDir: dir,
    socket: join(dir, "broker.sock"),
    domain: "https://open.feishu.cn",
    offline: true,
    continuous: true,
    graceMs: 1000,
  };
  const broker = await serve(cfg);
  t.after(() => broker.close());
  const a = new Bridge(cfg, { session_id: "a", name: "甲", harness: "test" }),
    b = new Bridge(cfg, { session_id: "b", name: "乙", harness: "test" });
  t.after(() => {
    a.close();
    b.close();
  });
  await Promise.all([a.open(false), b.open(false)]);
  const duplicate = new Bridge(cfg, a.session);
  await assert.rejects(duplicate.open(false), /already connected/);
  assert.equal(statSync(cfg.socket).mode & 0o777, 0o600);
  await a.call("route", { chat_id: "oc_chat", session_id: "a" });
  broker.store.ingest(message);
  const events = await a.call("fetch");
  assert.equal(events[0].payload.event.message.content, "你好");
  assert.deepEqual(await b.call("fetch"), []);
  await b.call("route", { chat_id: "oc_chat", session_id: "b" });
  await assert.rejects(
    a.call("ack", { id: events[0].id, receipt: events[0].receipt }),
    /reassigned/,
  );
  const [event] = await b.call("fetch");
  await b.call("ack", { receipt: event.receipt });
  assert.deepEqual(await b.call("fetch"), []);
  assert.equal((await a.call("sessions")).sessions.length, 2);
  await b.call('route',{chat_id:'oc_chat',session_id:'a'});
  broker.store.ingest({...message,header:{...message.header,event_id:'delegated'}});
  const [delegated]=await b.call('fetch_for',{session_id:'a',limit:1});
  assert.equal(delegated.id,'delegated');
  assert.equal((await b.call('raw_for',{session_id:'a',receipt:delegated.receipt})).payload.event.message.content,'你好');
  await b.call('ack_for',{session_id:'a',receipt:delegated.receipt});
  await assert.rejects(b.call('raw_for',{session_id:'a',receipt:delegated.receipt}),/expired/);
  assert.deepEqual(await a.call('fetch'),[]);
  broker.store.ingest({
    ...message,
    header: { ...message.header, event_id: 'p2p-resolve' },
    event: {
      sender: { sender_id: { open_id: 'ou_user' } },
      message: { ...message.event.message, chat_type: 'p2p' },
    },
  });
  assert.equal((await a.call('resolve_chat', { peer_id: 'ou_user' })).chat_id, 'oc_chat');
  await assert.rejects(a.call("token", { kind: "tenant" }), /offline/);
});

test("client retries broker launch while a previous startup lock is held", { timeout: 25000 }, async (t) => {
  const dir = temporary(t), configPath = join(dir, "config.json");
  writeFileSync(configPath, JSON.stringify({ appId: "offline-restart", stateDir: dir, graceMs: 1000 }));
  const savedConfig = process.env.LARK_BRIDGE_CONFIG;
  const savedOffline = process.env.LARK_BRIDGE_OFFLINE;
  process.env.LARK_BRIDGE_CONFIG = configPath;
  process.env.LARK_BRIDGE_OFFLINE = "1";
  t.after(() => {
    if (savedConfig === undefined) delete process.env.LARK_BRIDGE_CONFIG;
    else process.env.LARK_BRIDGE_CONFIG = savedConfig;
    if (savedOffline === undefined) delete process.env.LARK_BRIDGE_OFFLINE;
    else process.env.LARK_BRIDGE_OFFLINE = savedOffline;
  });
  const holder = spawn("flock", ["-n", join(dir, "broker.lock"), "sh", "-c", "printf READY; sleep 2"], { stdio: ["ignore", "pipe", "ignore"] });
  t.after(() => { try { holder.kill("SIGTERM"); } catch {} });
  await once(holder.stdout, "data");
  const cfg: Config = {
    appId: "offline-restart", stateDir: dir, socket: join(dir, "broker.sock"),
    domain: "https://open.feishu.cn", offline: true, continuous: false, graceMs: 1000,
  };
  const bridge = new Bridge(cfg, { session_id: "handoff", name: "Handoff", harness: "test" });
  let pid: number | undefined;
  try {
    await bridge.open();
    pid = (await bridge.call("status")).pid;
    assert.ok(pid);
  } finally {
    bridge.close();
    if (pid) try { process.kill(pid, "SIGTERM"); } catch {}
  }
});

test(
  "two simultaneous stdio MCP processes start one detached broker; parent exit does not kill it",
  { timeout: 25000 },
  async (t) => {
    const dir = temporary(t),
      configPath = join(dir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({ appId: "test-app", stateDir: dir, graceMs: 1000 }),
    );
    let pid: number | undefined;
    const clients: Client[] = [];
    t.after(async () => {
      await Promise.all(clients.map((c) => c.close().catch(() => {})));
      if (pid) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {}
      }
    });
    async function connectClient(id: string) {
      const client = new Client({ name: id, version: "1.0.0" });
      clients.push(client);
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [resolve("dist/index.js")],
          env: {
            PATH: process.env.PATH!,
            HOME: process.env.HOME!,
            LARK_BRIDGE_CONFIG: configPath,
            LARK_BRIDGE_OFFLINE: "1",
            LARK_BRIDGE_SESSION_ID: id,
          },
          stderr: "pipe",
        }),
      );
      return client;
    }
    const [a, b] = await Promise.all([
      connectClient("session-a"),
      connectClient("session-b"),
    ]);
    const status = async (c: Client) => {
      const result: any = await c.callTool(
        { name: "feishu_bridge_status", arguments: {} },
        undefined,
        { timeout: 2000 },
      );
      if (result.isError) throw new Error(result.content[0].text);
      return JSON.parse(result.content[0].text);
    };
    const sa = await status(a),
      sb = await status(b);
    pid = sa.pid;
    assert.equal(sa.pid, sb.pid);
    assert.equal(sb.sessions, 2);
    const tools = await b.listTools();
    for (const name of [
      "feishu_im_send",
      "feishu_im_read",
      "feishu_im_get_message",
      "feishu_im_fetch_resource",
      "feishu_im_send_confirm",
      "feishu_im_send_form",
      "feishu_im_send_progress",
      "feishu_im_patch_progress",
      "feishu_bridge_events",
    ])
      assert.ok(tools.tools.some((x) => x.name === name));
    await a.close();
    assert.equal((await status(b)).pid, pid);
    await b.callTool({
      name: "feishu_bridge_assign",
      arguments: { chat_id: "oc_persisted", session_id: "session-b" },
    });
    const oldPid = pid!;
    process.kill(oldPid, "SIGKILL");
    let restarted = false;
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 100));
      try {
        const next = await status(b);
        if (next.pid !== oldPid) {
          pid = next.pid;
          restarted = true;
          break;
        }
      } catch {
        /* Broker may still be restarting. */
      }
    }
    assert.ok(restarted, "session should reconnect after broker crash");
    const listed: any = await b.callTool({
      name: "feishu_bridge_sessions",
      arguments: {},
    });
    assert.ok(
      JSON.parse(listed.content[0].text).routes.some(
        (r: any) => r.chat === "oc_persisted" && r.session === "session-b",
      ),
    );
    await b.close();
    for (let i = 0; i < 80; i++) {
      try {
        process.kill(pid!, 0);
      } catch {
        pid = undefined;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(
      pid,
      undefined,
      "broker should exit after last session and grace period",
    );
  },
);

test("real SDK reassembles card frames, returns callback responses and forwards unknown event types", () => {
  const script = `
    import assert from 'node:assert/strict';
    import * as lark from '@larksuiteoapi/node-sdk';
    import {attachEventTransport,stderrLogger} from './dist/ws.js';
    const client=new lark.WSClient({appId:'test',appSecret:'test',logger:stderrLogger});
    const received=[],responses=[];
    client.eventDispatcher=attachEventTransport(client,raw=>{received.push(raw);return {toast:{type:'success',content:'accepted'}};});
    client.sendMessage=frame=>responses.push(JSON.parse(new TextDecoder().decode(frame.payload)));
    const frame=(type,id,event)=>({headers:[{key:'type',value:type},{key:'message_id',value:id},{key:'sum',value:'1'},{key:'seq',value:'0'}],payload:new TextEncoder().encode(JSON.stringify(event))});
    await client.handleEventData(frame('card','one',{header:{event_type:'card.action.trigger'},event:{context:{open_chat_id:'oc_chat'}}}));
    await client.handleEventData(frame('event','two',{header:{event_type:'future.event'},event:{chat_id:'oc_chat'}}));
    assert.equal(received.length,2);assert.equal(received[1].header.event_type,'future.event');
    assert.equal(JSON.parse(Buffer.from(responses[0].data,'base64').toString()).toast.content,'accepted');
    client.close({force:true});process.exit(0);
  `;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", script],
    { cwd: process.cwd(), encoding: "utf8", timeout: 5000 },
  );
  assert.equal(result.status, 0, result.stderr);
});

test("outbound SDK calls use broker tokens and preserve rich payloads without broker proxying", () => {
  const script = `
    import assert from 'node:assert/strict';
    import {setBridge} from './dist/bridge.js';
    import {getLarkClient,asUser} from './dist/client.js';
    const calls=[];setBridge({cfg:{appId:'test',domain:'https://open.feishu.cn'},call:async(method,args)=>{calls.push({method,args});return {token:args.kind+'-token'};}});
    const client=getLarkClient(),requests=[];
    client.httpInstance={request:async request=>{requests.push(request);return {code:0,data:{message_id:'om_result'}};}};
    await client.im.message.create({params:{receive_id_type:'chat_id'},data:{receive_id:'oc_chat',msg_type:'post',content:'rich-content'}});
    await client.im.message.list({params:{container_id_type:'chat',container_id:'oc_chat'}},await asUser());
    assert.equal(requests[0].headers.Authorization,'Bearer tenant-token');assert.equal(requests[0].data.content,'rich-content');
    assert.equal(requests[1].headers.Authorization,'Bearer user-token');assert.deepEqual(calls.map(x=>x.method),['token','token']);
  `;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", script],
    { cwd: process.cwd(), encoding: "utf8", timeout: 5000 },
  );
  assert.equal(result.status, 0, result.stderr);
});
