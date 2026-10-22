import { createServer, type Socket } from "node:net";
import { chmodSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { z } from "zod";
import { config, type Config } from "./config.js";
import { Store } from "./store.js";
import { Auth } from "./auth.js";
import { startWs } from "./ws.js";
import { acquireWsLock } from "./ws-lock.js";
import { patchAuthResultCard } from "./auth-card.js";

const id = z.string().min(1).max(512);
const chat = z.string().startsWith("oc_").max(512);
const schemas: Record<string, z.ZodTypeAny> = {
  register: z.object({ session_id: id, name: id, harness: id }),
  heartbeat: z.object({}),
  sessions: z.object({}),
  route: z.object({ chat_id: chat, session_id: id }),
  subscribe: z.object({
    session_id: id,
    mode: z.enum(["all", "all_except", "only"]),
    chats: z.array(chat).default([]),
  }),
  resolve_chat: z.object({ peer_id: z.string().startsWith("ou_").max(512) }),
  pause: z.object({ paused: z.boolean() }),
  fetch: z.object({
    limit: z.number().int().min(1).max(100).default(20),
    interaction_id: id.optional(),
  }),
  ack: z.object({ id: id.optional(), receipt: id }),
  raw: z.object({ id: id.optional(), receipt: id }),
  token: z.object({ kind: z.enum(["tenant", "user"]) }),
  auth_status: z.object({}),
  auth_start: z.object({ scope: z.string().max(8000) }),
  auth_card_register: z.object({ message_id: id, verification_url: z.string().url() }),
  card_register: z.object({
    id,
    chat_id: chat,
    expires_at: z.number().finite(),
    kind: z.enum(["confirm", "form", "progress", "custom", "proxy_token"]),
    data: z.any(),
    responses: z.record(z.any()).optional(),
  }),
  card_bind: z.object({ id, message_id: id }),
  card_cancel: z.object({ id }),
  card_get: z.object({ id }),
  card_progress: z.object({
    id,
    current_step: z.number().int().min(0),
    step_updates: z
      .array(z.object({ index: z.number().int().min(0), detail: z.string() }))
      .default([]),
  }),
  fetch_for: z.object({ session_id: id, limit: z.number().int().min(1).max(100).default(20) }),
  ack_for: z.object({ session_id: id, id: id.optional(), receipt: id }),
  raw_for: z.object({ session_id: id, id: id.optional(), receipt: id }),
  status: z.object({}),
  schedule_create: z.object({
    session_id: id, label: z.string().min(1).max(1000),
    fire_at: z.string().optional(), cron: z.string().optional(),
    timezone: z.string().default("Asia/Shanghai"),
  }),
  schedule_list: z.object({ session_id: id }),
  schedule_delete: z.object({ session_id: id, id }),
  proxy_issue: z.object({ hash: z.string().regex(/^[a-f0-9]{64}$/), expires_at: z.number().finite() }),
  proxy_check: z.object({ hash: z.string().regex(/^[a-f0-9]{64}$/) }),
  proxy_revoke: z.object({ hash: z.string().regex(/^[a-f0-9]{64}$/) }),
};

export async function serve(cfg: Config) {
  const wsLease = cfg.offline ? null : await acquireWsLock(cfg.appId);
  if (!cfg.offline && !wsLease)
    throw new Error("Another local process owns this app's Lark WebSocket");
  const store = new Store(cfg.stateDir),
    auth = new Auth(cfg);
  const peers = new Map<string, { socket: Socket; seen: number }>();
  const authCards = new Map<string, string>();
  let patchingAuthCards = false;
  const patchAuthCards = async () => {
    if (patchingAuthCards || !authCards.size) return;
    patchingAuthCards = true;
    try {
      const flow = auth.status().oauth;
      for (const [messageId, url] of authCards) {
        if (flow?.verification_url === url && flow.status === 'pending') continue;
        const status = flow?.verification_url !== url ? 'replaced' : flow.status;
        try {
          const token = await auth.token('tenant');
          await patchAuthResultCard(cfg.domain, messageId, token, status === 'authorized' ? 'authorized'
            : status === 'expired' ? 'expired' : status === 'denied_or_failed' ? 'denied_or_failed' : 'replaced');
          authCards.delete(messageId);
        } catch (error) {
          process.stderr.write(`[bridge] OAuth card update failed: ${error instanceof Error ? error.message : error}\n`);
        }
      }
    } finally { patchingAuthCards = false; }
  };
  const sockets = new Set<Socket>();
  let emptySince = Date.now(),
    closing = false;
  let finish!: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const send = (socket: Socket, value: unknown) => {
    if (socket.writableLength > 2 * 1024 * 1024) {
      socket.destroy();
      return;
    }
    if (!socket.destroyed) socket.write(JSON.stringify(value) + "\n");
  };
  const notify = () => {
    for (const [session, { socket }] of peers) {
      const pending = store.pending(session);
      if (pending.length) send(socket, { notice: "events", events: pending });
    }
  };
  const ws = cfg.offline
    ? undefined
    : startWs(cfg, (raw) => {
        const event = store.ingest(raw);
        if (!event.duplicate) notify();
        return event.response;
      });
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "",
      session: string | undefined;
    socket.on("error", () => {});
    const dispatch = async (message: any) => {
      if (
        !message ||
        !Number.isSafeInteger(message.id) ||
        !Object.hasOwn(schemas, message.method)
      )
        throw new Error("Invalid request");
      const args = schemas[message.method].parse(message.params ?? {});
      if (message.method === "register") {
        if (session) throw new Error("Connection already registered");
        if (peers.has(args.session_id))
          throw new Error("Session ID already connected");
        session = args.session_id;
        peers.set(session!, { socket, seen: Date.now() });
        const registration = store.register(session!, args.name, args.harness);
        return { session_id: session, ...registration };
      }
      if (!session) throw new Error("Register this session first");
      peers.get(session)!.seen = Date.now();
      switch (message.method) {
        case "heartbeat":
          store.db
            .prepare("UPDATE sessions SET seen=? WHERE id=?")
            .run(Date.now(), session);
          return {};
        case "sessions":
          return store.list();
        case "route":
          store.route(args.chat_id, args.session_id);
          notify();
          return {};
        case "subscribe": {
          const result = store.subscribe(args.session_id, args.mode, args.chats);
          notify();
          return result;
        }
        case "resolve_chat":
          return { chat_id: store.chatForPeer(args.peer_id) };
        case "pause":
          store.pause(session, args.paused);
          notify();
          return {};
        case "fetch":
          return store.claim(session, args.limit, args.interaction_id);
        case "ack":
          store.ack(session, args.id, args.receipt);
          return {};
        case "raw":
          return store.raw(session, args.id, args.receipt);
        case "fetch_for":
          return store.claim(args.session_id, args.limit);
        case "ack_for":
          store.ack(args.session_id, args.id, args.receipt);
          return {};
        case "raw_for":
          return store.raw(args.session_id, args.id, args.receipt);
        case "token":
          return { token: await auth.token(args.kind) };
        case "auth_status":
          return auth.status();
        case "auth_start":
          return await auth.start(args.scope);
        case "auth_card_register":
          if (auth.status().oauth?.verification_url !== args.verification_url)
            throw new Error("Authorization flow does not match the card");
          authCards.set(args.message_id, args.verification_url);
          void patchAuthCards();
          return {};
        case "card_register":
          store.interaction(args);
          return {};
        case "card_bind":
          store.bind(args.id, args.message_id);
          return {};
        case "card_cancel":
          store.cancel(args.id);
          return {};
        case "card_progress":
          return store.updateProgress(
            args.id,
            args.current_step,
            args.step_updates,
          );
        case "card_get": {
          const row = store.getInteraction(args.id);
          return row
            ? {
                ...JSON.parse(row.state),
                message_id: row.message,
                status: row.status,
              }
            : null;
        }
        case "status":
          return {
            pid: process.pid,
            app_id: cfg.appId,
            offline: cfg.offline,
            sessions: peers.size,
            connection: ws?.status(),
            auth: auth.status(),
          };
        case "schedule_create":
          return store.createSchedule(args.session_id, args.label, args.fire_at, args.cron, args.timezone);
        case "schedule_list":
          return { schedules: store.listSchedules(args.session_id) };
        case "schedule_delete":
          return { deleted: store.deleteSchedule(args.session_id, args.id), id: args.id };
        case "proxy_issue":
          store.issueProxyToken(args.hash, args.expires_at);
          return {};
        case "proxy_check":
          return store.proxyTokenStatus(args.hash);
        case "proxy_revoke":
          return { revoked: store.revokeProxyToken(args.hash) };
      }
    };
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      if (Buffer.byteLength(buffer) > 2 * 1024 * 1024) {
        socket.destroy();
        return;
      }
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        let message: any;
        try {
          message = JSON.parse(line);
        } catch {
          socket.destroy();
          return;
        }
        void dispatch(message)
          .then((result) => send(socket, { id: message?.id, result }))
          .catch((error) =>
            send(socket, {
              id: message?.id,
              error:
                error instanceof z.ZodError
                  ? "Invalid request parameters"
                  : String(error.message),
            }),
          );
      }
    });
    socket.on("close", () => {
      sockets.delete(socket);
      if (!closing && session && peers.get(session)?.socket === socket) {
        peers.delete(session);
        store.disconnect(session);
        if (!peers.size) emptySince = Date.now();
      }
    });
  });
  // The process-wide flock is held before touching a previous socket.
  try {
    unlinkSync(cfg.socket);
  } catch (e: any) {
    if (e.code !== "ENOENT") throw e;
  }
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(cfg.socket, () => {
        chmodSync(cfg.socket, 0o600);
        resolve();
      });
    });
  } catch (error) {
    ws?.close();
    auth.close();
    store.close();
    await wsLease?.release();
    throw error;
  }
  const close = async () => {
    if (closing) return done;
    closing = true;
    clearInterval(timer);
    ws?.close();
    await wsLease?.release();
    auth.close();
    for (const session of peers.keys()) store.disconnect(session);
    peers.clear();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    process.removeListener("SIGINT", signal);
    process.removeListener("SIGTERM", signal);
    finish();
  };
  const timer = setInterval(() => {
    for (const [, peer] of peers)
      if (Date.now() - peer.seen > 45_000) peer.socket.destroy();
    store.expire();
    store.fireSchedules();
    void patchAuthCards();
    notify();
    if (
      !cfg.continuous &&
      !peers.size &&
      Date.now() - emptySince >= cfg.graceMs
    )
      void close();
  }, 5000);
  const signal = () => {
    void close();
  };
  process.once("SIGINT", signal);
  process.once("SIGTERM", signal);
  wsLease?.onLost(() => { void close(); });
  return { close, store, done };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const cfg = config();
  if (process.argv.includes("--locked-worker")) {
    serve(cfg)
      .then(async (broker) => {
        await broker.done;
        process.exit(0);
      })
      .catch(() => {
        process.stderr.write(
          "[bridge] Broker startup failed; check configuration and state directory\n",
        );
        process.exit(1);
      });
  } else {
    const child = spawn(
      "flock",
      [
        "-n",
        join(cfg.stateDir, "broker.lock"),
        process.execPath,
        ...process.execArgv,
        fileURLToPath(import.meta.url),
        "--locked-worker",
      ],
      { stdio: "inherit" },
    );
    child.on("error", () => {
      process.stderr.write("[bridge] Linux flock is required\n");
      process.exitCode = 1;
    });
    child.on("exit", (code) => {
      process.exitCode = code ?? 1;
    });
  }
}
