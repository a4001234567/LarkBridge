import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { request as httpsRequest } from "node:https";
import { createHash, randomBytes } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getBridge } from "../bridge.js";
import { asUser, getLarkClient, getUserToken, withAuth } from "../client.js";

type TokenEntry = {
  hash: string;
  reason: string;
  expires: number;
  interactionId: string;
  messageId: string;
  calls: number;
  methods: Map<string, number>;
  patchTimer?: ReturnType<typeof setTimeout>;
};

const entries = new Map<string, TokenEntry>();
let proxy: Server | undefined;
let proxyPort = 0;
let starting: Promise<void> | undefined;

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function card(entry: TokenEntry, inactive = false) {
  const calls = [...entry.methods].map(([method, count]) => `${method} ×${count}`).join("\n") || "None yet";
  return {
    schema: "2.0",
    header: { template: inactive ? "grey" : "yellow",
      title: { tag: "plain_text", content: "Temporary Lark API token" } },
    body: { elements: [
      { tag: "markdown", content: `**Reason:** ${entry.reason}\n**Expires:** ${new Date(entry.expires).toISOString()}\n**Calls:** ${entry.calls}\n**Status:** ${inactive ? "Stopped" : "Active"}` },
      { tag: "markdown", content: `**API calls**\n${calls}` },
      inactive
        ? { tag: "button", type: "default", disabled: true, text: { tag: "plain_text", content: "Stopped" } }
        : { tag: "button", type: "danger", text: { tag: "plain_text", content: "Stop" },
          behaviors: [{ type: "callback", value: { action: "stop_token", bridge_interaction_id: entry.interactionId } }] },
    ] },
  };
}

async function patchCard(entry: TokenEntry) {
  const status = await getBridge().call("proxy_check", { hash: entry.hash });
  await getLarkClient().im.message.patch({
    path: { message_id: entry.messageId },
    data: { content: JSON.stringify(card(entry, !status.valid)) },
  });
}

function json(res: ServerResponse, code: number, value: unknown) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
}

async function readBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += part.length;
    if (length > 20 * 1024 * 1024) throw new Error("Request body exceeds 20 MiB");
    chunks.push(part);
  }
  return Buffer.concat(chunks);
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  try {
    const bearer = req.headers.authorization ?? "";
    const token = bearer.startsWith("Bearer ") ? bearer.slice(7).trim() : "";
    const entry = token ? entries.get(hashToken(token)) : undefined;
    if (!entry) return json(res, 401, { error: "invalid_token" });
    const status = await getBridge().call("proxy_check", { hash: entry.hash });
    if (!status.valid) return json(res, 403, { error: status.revoked ? "token_revoked" : "token_expired" });
    if (!req.url?.startsWith("/open-apis/")) return json(res, 400, { error: "invalid_api_path" });
    const body = await readBody(req);
    const userToken = await getUserToken();
    const target = new URL(getBridge().cfg.domain);
    if (target.protocol !== "https:") throw new Error("Lark API domain must use HTTPS");
    const result = await new Promise<{ status: number; headers: Record<string, string>; body: Buffer }>((resolve, reject) => {
      const outgoing = httpsRequest({ hostname: target.hostname, port: target.port || 443,
        path: req.url, method: req.method ?? "GET", headers: {
          Authorization: `Bearer ${userToken}`,
          "Content-Type": req.headers["content-type"] ?? "application/json",
          ...(body.length ? { "Content-Length": String(body.length) } : {}),
        } }, response => {
        const chunks: Buffer[] = [];
        response.on("data", part => chunks.push(Buffer.from(part)));
        response.on("end", () => resolve({ status: response.statusCode ?? 502,
          headers: { "Content-Type": String(response.headers["content-type"] ?? "application/octet-stream") },
          body: Buffer.concat(chunks) }));
      });
      outgoing.setTimeout(30_000, () => outgoing.destroy(new Error("Lark API timeout")));
      outgoing.on("error", reject);
      if (body.length) outgoing.write(body);
      outgoing.end();
    });
    const path = req.url.split("?")[0].split("/").slice(0, 5).join("/");
    const key = `${req.method ?? "GET"} ${path}`;
    entry.calls++;
    entry.methods.set(key, (entry.methods.get(key) ?? 0) + 1);
    clearTimeout(entry.patchTimer);
    entry.patchTimer = setTimeout(() => void patchCard(entry).catch(() => {}), 2000);
    entry.patchTimer.unref();
    res.writeHead(result.status, result.headers);
    res.end(result.body);
  } catch (error: any) {
    json(res, 502, { error: "proxy_error", message: error.message ?? String(error) });
  }
}

async function startProxy() {
  if (proxy) return;
  if (!starting) starting = (async () => {
    const server = createServer((req, res) => void handle(req, res));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    proxy = server;
    proxyPort = (server.address() as { port: number }).port;
    server.unref();
  })().finally(() => { starting = undefined; });
  await starting;
}

export function closeTokenProxy() {
  for (const entry of entries.values()) clearTimeout(entry.patchTimer);
  proxy?.close();
  proxy = undefined;
}

export function registerTokenProxyTools(server: McpServer) {
  server.tool(
    "feishu_auth_issue_token",
    "Issue a short-lived local HTTP proxy token for scripts to call Lark APIs without seeing the user access token. A monitoring card with a Stop button is sent to the authenticated user.",
    {
      ttl_minutes: z.number().min(1).max(1440).default(5),
      reason: z.string().min(1).max(100),
    },
    ({ ttl_minutes, reason }) => withAuth(async () => {
      await getUserToken();
      await startProxy();
      const bridge = getBridge();
      const info = await (getLarkClient().authen as any).userInfo.get({}, await asUser());
      if (info.code !== 0) throw new Error(`Lark API ${info.code}: ${info.msg}`);
      const owner = info.data?.user_info?.open_id ?? info.data?.open_id;
      if (!owner) throw new Error("Could not identify token owner");
      const token = `lmk_${randomBytes(24).toString("base64url")}`;
      const entry: TokenEntry = {
        hash: hashToken(token), reason, expires: Date.now() + ttl_minutes * 60_000,
        interactionId: randomBytes(12).toString("hex"), messageId: "", calls: 0, methods: new Map(),
      };
      const sent = await getLarkClient().im.message.create({
        params: { receive_id_type: "open_id" },
        data: { receive_id: owner, msg_type: "interactive", content: JSON.stringify(card(entry)) },
      });
      if (sent.code !== 0 || !sent.data?.message_id || !sent.data?.chat_id)
        throw new Error(`Could not send token monitoring card: ${sent.msg}`);
      entry.messageId = sent.data.message_id;
      try {
        await bridge.call("proxy_issue", { hash: entry.hash, expires_at: entry.expires });
        await bridge.call("card_register", {
          id: entry.interactionId, chat_id: sent.data.chat_id, expires_at: entry.expires,
          kind: "proxy_token", data: { token_hash: entry.hash },
          responses: { stop_token: {
            toast: { type: "success", content: "Token revoked" },
            card: { type: "raw", data: card(entry, true) },
          } },
        });
        await bridge.call("card_bind", { id: entry.interactionId, message_id: entry.messageId });
      } catch (error) {
        await bridge.call("proxy_revoke", { hash: entry.hash }).catch(() => {});
        throw error;
      }
      entries.set(entry.hash, entry);
      const timer = setTimeout(() => void patchCard(entry).catch(() => {}), ttl_minutes * 60_000 + 500);
      timer.unref();
      return { token, proxy_url: `http://127.0.0.1:${proxyPort}`,
        expires_at: new Date(entry.expires).toISOString(), ttl_minutes };
    }),
  );
}
