import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { config } from "./config.js";
import { Bridge, setBridge } from "./bridge.js";
import { registerImTools } from "./tools/im.js";
import { registerCardTools } from "./tools/cards.js";
import { registerPeopleTools } from "./tools/people.js";
import { registerCalendarTools } from "./tools/calendar.js";
import { registerTaskTools } from "./tools/task.js";
import { registerDocTools } from "./tools/docs.js";
import { registerTokenProxyTools, closeTokenProxy } from "./tools/token-proxy.js";
import { asUser, withAuth } from "./client.js";
import { CodexNotifier } from "./codex-notifier.js";
import { formatEvents } from "./format-events.js";
import { expandForwardedEvents } from "./enrich-events.js";
import { getLarkClient } from "./client.js";
import { MODULE_SCOPES, scopesForModule } from "./auth-guard.js";

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
registerPeopleTools(server);
registerCalendarTools(server);
registerTaskTools(server);
registerDocTools(server);
registerTokenProxyTools(server);
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
  "Get shared user authorization status and granted modules.",
  {},
  () => withAuth(async () => {
    const status = await bridge.call("auth_status");
    const granted_modules = status.authenticated && status.scopes?.length
      ? Object.entries(MODULE_SCOPES).filter(([, scopes]) => scopes.every(scope => status.scopes.includes(scope))).map(([name]) => name)
      : [];
    return { ...status, granted_modules,
      pending_modules: Object.keys(MODULE_SCOPES).filter(name => !granted_modules.includes(name)) };
  }),
);
server.tool(
  "feishu_auth_whoami",
  "Return the authenticated user's open_id, name, and user_id.",
  {},
  () => withAuth(async () => {
    const res = await (getLarkClient().authen as any).userInfo.get({}, await asUser());
    if (res.code !== 0) throw new Error(`Lark API ${res.code}: ${res.msg}`);
    const user = res.data?.user_info ?? res.data ?? {};
    return { open_id: user.open_id, name: user.name, en_name: user.en_name, user_id: user.user_id };
  }),
);
server.tool(
  "feishu_auth_init",
  "Start shared OAuth device authorization for a module or explicit scopes. The broker polls in the background. Optionally send the authorization link as a Lark card.",
  {
    module: z.enum(["im", "calendar", "task", "docs", "people", "all"]).default("all"),
    scope: z.string().optional().describe("Space-separated OAuth scopes; overrides module"),
    receive_id: z.string().regex(/^(ou_|oc_)/).optional().describe("Open ID or chat ID to receive the authorization card"),
  },
  ({ module, scope, receive_id }) => withAuth(async () => {
    const result = await bridge.call("auth_start", { scope: scope ?? scopesForModule(module).join(" ") });
    if (!receive_id || !result.verification_url) return result;
    const sent = await getLarkClient().im.message.create({
      params: { receive_id_type: receive_id.startsWith("oc_") ? "chat_id" : "open_id" },
      data: { receive_id, msg_type: "interactive", content: JSON.stringify({
        schema: "2.0", header: { template: "blue", title: { tag: "plain_text", content: "Authorize Lark access" } },
        body: { elements: [
          { tag: "markdown", content: `Authorize **${module}** access for the Lark Bridge.` },
          { tag: "button", type: "primary", text: { tag: "plain_text", content: "Open authorization" },
            behaviors: [{ type: "open_url", default_url: result.verification_url }] },
        ] },
      }) },
    });
    if (sent.code !== 0) throw new Error(`Could not send authorization card: ${sent.msg}`);
    if (sent.data?.message_id)
      await bridge.call("auth_card_register", { message_id: sent.data.message_id,
        verification_url: result.verification_url });
    return { ...result, message_id: sent.data?.message_id };
  }),
);
const scheduleTarget = (requested?: string) => {
  const target = requested ?? (session_id.startsWith("mcp-") ? undefined : session_id);
  if (!target) throw new Error("Pass session_id for the agent session that should receive the reminder");
  return target;
};
server.tool(
  "feishu_schedule_create",
  "Create a one-shot or recurring reminder delivered to an agent session by the broker. Pass the Codex thread ID as session_id when using a separate MCP process.",
  {
    session_id: z.string().optional(), label: z.string().min(1),
    fire_at: z.string().optional(), cron: z.string().optional(),
    timezone: z.string().default("Asia/Shanghai"),
  },
  (args) => withAuth(() => bridge.call("schedule_create", { ...args, session_id: scheduleTarget(args.session_id) })),
);
server.tool(
  "feishu_schedule_list",
  "List pending reminders for an agent session.",
  { session_id: z.string().optional() },
  (args) => withAuth(() => bridge.call("schedule_list", { session_id: scheduleTarget(args.session_id) })),
);
server.tool(
  "feishu_schedule_delete",
  "Delete a pending reminder by ID.",
  { session_id: z.string().optional(), id: z.string() },
  (args) => withAuth(() => bridge.call("schedule_delete", { session_id: scheduleTarget(args.session_id), id: args.id })),
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
  closeTokenProxy();
  void server.close();
};
process.once("SIGINT", close);
process.once("SIGTERM", close);
process.stdin.once("end", close);
