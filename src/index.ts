import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { config } from "./config.js";
import { Bridge, setBridge } from "./bridge.js";
import { registerImTools } from "./tools/im.js";
import { registerCardTools } from "./tools/cards.js";
import { withAuth } from "./client.js";
import { CodexNotifier } from "./codex-notifier.js";
import { formatEvents } from "./format-events.js";
import { expandForwardedEvents } from "./enrich-events.js";
import { getLarkClient } from "./client.js";

const session_id = process.env.LARK_BRIDGE_SESSION_ID ?? process.env.CODEX_THREAD_ID ?? process.env.CODEX_SESSION_ID ?? `mcp-${process.pid}`;
const bridge = new Bridge(config(), {
  session_id,
  name: process.env.LARK_BRIDGE_SESSION_NAME ?? session_id,
  harness: process.env.LARK_BRIDGE_HARNESS ?? "mcp",
});
setBridge(bridge);
if (bridge.session.harness === "codex") new CodexNotifier(session_id, bridge);
const server = new McpServer(
  { name: "lark-session-bridge", version: "0.1.0" },
  { capabilities: { logging: {} } },
);
registerImTools(server);
registerCardTools(server);
server.tool(
  "feishu_bridge_sessions",
  "List sessions and chat assignments.",
  {},
  () => withAuth(() => bridge.call("sessions")),
);
server.tool(
  "feishu_bridge_assign",
  "Subscribe a live session to one chat. A chat held by another live session cannot be taken; have that session exclude or release it first.",
  { chat_id: z.string().startsWith("oc_"), session_id: z.string() },
  (args) => withAuth(() => bridge.call("route", args)),
);
server.tool(
  "feishu_bridge_subscribe",
  "Replace a live session's chat filter: all chats, all except listed chats, or only listed chats. Overlap with another live session is rejected. Pass only with an empty list to release all chats.",
  {
    session_id: z.string(),
    mode: z.enum(["all", "all_except", "only"]),
    chats: z.array(z.string().startsWith("oc_")).default([]),
  },
  (args) => withAuth(() => bridge.call("subscribe", args)),
);
server.tool(
  "feishu_bridge_pause",
  "Pause or resume incoming event delivery for this session.",
  { paused: z.boolean() },
  (args) => withAuth(() => bridge.call("pause", args)),
);
server.tool(
  "feishu_bridge_events",
  "Retrieve Lark events for this session or the specified Codex thread. Delivery is handled by the bridge; no acknowledgment is needed. Pass raw=true for full Lark payloads.",
  { limit: z.number().int().min(1).max(100).default(20), session_id: z.string().optional(), raw: z.boolean().default(false) },
  async ({ raw, ...args }) => {
    try {
      const events = await (args.session_id ? bridge.call("fetch_for", args) : bridge.call("fetch", args));
      const shown = raw ? events : await expandForwardedEvents(events,
        messageId => getLarkClient().im.message.get({ path: { message_id: messageId } }));
      const text = raw
        ? JSON.stringify(events.map(({ receipt: _receipt, ...event }: any) => event), null, 2)
        : formatEvents(shown);
      for (const event of events)
        await bridge.call(args.session_id ? "ack_for" : "ack", {
          ...(args.session_id ? { session_id: args.session_id } : {}),
          id: event.id,
          receipt: event.receipt,
        });
      return { content: [{ type: "text" as const, text }] };
    } catch (error: any) {
      return { isError: true, content: [{ type: "text" as const, text: error.message ?? "Request failed" }] };
    }
  },
);
server.tool(
  "feishu_bridge_status",
  "Get broker, connection and authorization status without credentials.",
  {},
  () => withAuth(() => bridge.call("status")),
);
server.tool(
  "feishu_auth_status",
  "Get shared user authorization status.",
  {},
  () => withAuth(() => bridge.call("auth_status")),
);
server.tool(
  "feishu_auth_init",
  "Start shared OAuth device authorization. Open the returned URL; the broker polls and saves authorization in the background.",
  {
    scope: z
      .string()
      .describe("Space-separated Lark OAuth scopes")
      .default("offline_access"),
  },
  (args) => withAuth(() => bridge.call("auth_start", args)),
);
let lastNotice = "",
  lastNoticeAt = 0,
  closing = false,
  reconnecting = false;
bridge.on("notice", (notice) => {
  const key = JSON.stringify(notice.events);
  if (key === lastNotice && Date.now() - lastNoticeAt < 30_000) return;
  lastNotice = key;
  lastNoticeAt = Date.now();
  void server.server
    .sendLoggingMessage({
      level: "info",
      logger: "lark-bridge",
      data: {
        message: "Lark events available; use feishu_bridge_events",
        count: notice.events.length,
      },
    })
    .catch(() => {});
});
bridge.on("disconnect", () => {
  if (closing || reconnecting) return;
  reconnecting = true;
  void (async () => {
    for (let delay = 250; !closing; delay = Math.min(delay * 2, 5000)) {
      await new Promise((r) => setTimeout(r, delay));
      if (closing) break;
      try {
        await bridge.open();
        break;
      } catch {}
    }
    reconnecting = false;
  })();
});
await bridge.open();
await server.connect(new StdioServerTransport());
const close = () => {
  if (closing) return;
  closing = true;
  bridge.close();
  void server.close();
};
process.once("SIGINT", close);
process.once("SIGTERM", close);
process.stdin.once("end", close);
