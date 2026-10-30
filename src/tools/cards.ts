import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getBridge } from "../bridge.js";
import { getLarkClient, withAuth, assertOk } from "../client.js";
import {
  buildConfirmActiveCard,
  buildFormActiveCard,
  buildConfirmExpiredCard,
  buildFormExpiredCard,
} from "../cards/interactive.js";
import { buildProgressCard } from "../cards/progress.js";
import type { Interaction } from "../store.js";
import { formatEvents } from "../format-events.js";
import { expandForwardedEvents } from "../enrich-events.js";

async function progressMessages(sessionId: string | undefined) {
  if (!sessionId) return {};
  const bridge = getBridge();
  const events = await bridge.call("drain_for", {
    session_id: sessionId, limit: 100, consumer: "progress",
  });
  if (!events.length) return {};
  const shown = await expandForwardedEvents(events,
    messageId => getLarkClient().im.message.get({ path: { message_id: messageId } }));
  const lark_messages = `Lark (reply via Lark tools):\n${formatEvents(shown)}`;
  for (const event of events)
    await bridge.call("ack_for", { session_id: sessionId, id: event.id, receipt: event.receipt });
  return { lark_messages };
}

export function correlate(card: any, id: string): any {
  if (Array.isArray(card)) return card.map((x) => correlate(x, id));
  if (!card || typeof card !== "object") return card;
  const result = Object.fromEntries(
    Object.entries(card).map(([k, v]) => [k, correlate(v, id)]),
  );
  if (result.type === "callback")
    result.value = { ...(result.value ?? {}), bridge_interaction_id: id };
  return result;
}
async function send(entry: Interaction, card: object) {
  const bridge = getBridge();
  await bridge.call("card_register", entry);
  let message_id: string | undefined;
  try {
    const result = await getLarkClient().im.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: entry.chat_id,
        msg_type: "interactive",
        content: JSON.stringify(correlate(card, entry.id)),
      },
    });
    assertOk(result);
    message_id = result.data?.message_id;
    if (!message_id) throw new Error("Lark did not return a message ID");
    await bridge.call("card_bind", { id: entry.id, message_id });
    return {
      message_id,
      interaction_id: entry.id,
      expires_at: entry.expires_at,
    };
  } catch (e) {
    // Once sent, correlation in the card still works even if binding fails.
    if (!message_id)
      await bridge.call("card_cancel", { id: entry.id }).catch(() => {});
    throw e;
  }
}
async function waitForAction(
  entry: Interaction,
  message_id: string,
  signal: AbortSignal,
) {
  const bridge = getBridge();
  while (Date.now() < entry.expires_at) {
    if (signal.aborted)
      throw new Error(
        "Card wait cancelled; card remains available for asynchronous processing",
      );
    const events = await bridge.call("fetch", {
      limit: 1,
      interaction_id: entry.id,
    });
    if (events.length) {
      const event = events[0],
        action = event.payload.event?.action ?? {};
      await bridge.call("ack", { id: event.id, receipt: event.receipt });
      return {
        message_id,
        action: action.value?.action ?? "form_submit",
        form_value: action.form_value,
        timed_out: false,
      };
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  const expired =
    entry.kind === "form"
      ? buildFormExpiredCard(entry.data)
      : buildConfirmExpiredCard(entry.data);
  const result = await getLarkClient().im.message.patch({
    path: { message_id },
    data: { content: JSON.stringify(expired) },
  });
  assertOk(result);
  return { message_id, action: "timeout", timed_out: true };
}
export function registerCardTools(server: McpServer) {
  const common = {
    receive_id: z
      .string()
      .startsWith("oc_")
      .describe("Originating chat ID; routing uses this chat only"),
    title: z.string(),
    body: z.string().optional(),
    blocking: z.boolean().default(false),
    timeout_seconds: z.number().int().min(10).max(86400).default(3600),
  };
  server.tool(
    "feishu_im_send_confirm",
    "Send a confirm/cancel card. Defaults to asynchronous chat-routed actions; optionally wait for its result.",
    {
      ...common,
      confirm_label: z.string().default("确认"),
      cancel_label: z.string().default("取消"),
      template: z
        .enum(["red", "orange", "blue", "green", "grey", "wathet"])
        .default("red"),
    },
    async (args, extra) =>
      withAuth(async () => {
        const entry: Interaction = {
          id: randomUUID(),
          chat_id: args.receive_id,
          expires_at: Date.now() + args.timeout_seconds * 1000,
          kind: "confirm",
          data: {
            ...args,
            card_type: "confirm",
            expiry_at: Date.now() + args.timeout_seconds * 1000,
          },
        };
        const result = await send(entry, buildConfirmActiveCard(entry.data));
        return args.blocking
          ? waitForAction(entry, result.message_id, extra.signal)
          : result;
      }),
  );
  server.tool(
    "feishu_im_send_form",
    "Send an interactive form. Submissions follow the originating chat assignment.",
    {
      ...common,
      fields: z
        .array(
          z.object({
            name: z.string(),
            label: z.string(),
            placeholder: z.string().optional(),
            required: z.boolean().optional(),
            hidden: z.boolean().optional(),
          }),
        )
        .min(1),
      submit_label: z.string().default("提交"),
    },
    async (args, extra) =>
      withAuth(async () => {
        const entry: Interaction = {
          id: randomUUID(),
          chat_id: args.receive_id,
          expires_at: Date.now() + args.timeout_seconds * 1000,
          kind: "form",
          data: {
            ...args,
            card_type: "form",
            confirm_label: "确认",
            cancel_label: "取消",
            expiry_at: Date.now() + args.timeout_seconds * 1000,
          },
        };
        const result = await send(entry, buildFormActiveCard(entry.data));
        return args.blocking
          ? waitForAction(entry, result.message_id, extra.signal)
          : result;
      }),
  );
  server.tool(
    "feishu_im_send_progress",
    "Send a progress card with a Stop button; clicks are delivered to the chat-assigned session. Steps can include a short detail distinct from the label, including for future steps.",
    {
      receive_id: common.receive_id,
      title: z.string(),
      steps: z
        .array(z.object({
          label: z.string(),
          detail: z.string().optional().describe("Short explanation shown when this step is expanded; do not repeat the label"),
        }))
        .min(1),
      current_step: z.number().int().min(0).default(0),
    },
    async (args) =>
      withAuth(async () => {
        const entry: Interaction = {
          id: randomUUID(),
          chat_id: args.receive_id,
          expires_at: Date.now() + 86400_000,
          kind: "progress",
          data: {
            title: args.title,
            steps: args.steps,
            currentStep: args.current_step,
          },
        };
        return send(
          entry,
          buildProgressCard(args.title, args.steps, args.current_step),
        );
      }),
  );
  server.tool(
    "feishu_im_patch_progress",
    "Update a progress card. Reports a Stop click before updating; clicks still route through the chat assignment. Optionally drain the current Codex session's ready Lark messages.",
    {
      message_id: z.string(),
      session_id: z.string().optional().describe("Codex thread ID to check for a ready Lark message batch"),
      current_step: z.number().int().min(0),
      step_updates: z
        .array(z.object({ index: z.number().int().min(0), detail: z.string() }))
        .default([]),
    },
    async (args) =>
      withAuth(async () => {
        const bridge = getBridge();
        const state = await bridge.call("card_progress", {
          id: args.message_id,
          current_step: args.current_step,
          step_updates: args.step_updates,
        });
        if (state.status === "responded")
          return {
            message_id: args.message_id,
            result: "User asked to stop — abort the task.",
            ...await progressMessages(args.session_id),
          };
        if (state.status !== "active")
          throw new Error("Progress card expired or cancelled");
        const card = correlate(
          buildProgressCard(
            state.data.title,
            state.data.steps,
            args.current_step,
          ),
          state.id,
        );
        const result = await getLarkClient().im.message.patch({
          path: { message_id: args.message_id },
          data: { content: JSON.stringify(card) },
        });
        assertOk(result);
        return {
          message_id: args.message_id,
          result:
            args.current_step >= state.data.steps.length
              ? "Task complete."
              : "Updated.",
          ...await progressMessages(args.session_id),
        };
      }),
  );
  server.tool(
    "feishu_im_update_card",
    "Update an existing card directly through Lark. For interactive cards, retain their bridge_interaction_id in callback values.",
    {
      message_id: z.string(),
      card: z.string(),
    },
    async ({ message_id, card }) =>
      withAuth(async () => {
        JSON.parse(card);
        const result = await getLarkClient().im.message.patch({
          path: { message_id },
          data: { content: card },
        });
        assertOk(result);
        return { updated: true, message_id };
      }),
  );
  server.tool(
    "feishu_im_send_card",
    "Send a custom interactive card with predefined immediate responses keyed by action.value.action. Click delivery always follows the chat.",
    {
      receive_id: common.receive_id,
      card: z.string(),
      responses: z
        .record(
          z.object({
            toast: z
              .object({
                type: z.enum(["info", "success", "error"]),
                content: z.string(),
              })
              .optional(),
            card: z
              .object({ type: z.literal("raw"), data: z.record(z.any()) })
              .optional(),
          }),
        )
        .default({}),
      timeout_seconds: common.timeout_seconds,
    },
    async (args) =>
      withAuth(async () =>
        send(
          {
            id: randomUUID(),
            chat_id: args.receive_id,
            expires_at: Date.now() + args.timeout_seconds * 1000,
            kind: "custom",
            data: {},
            responses: args.responses,
          },
          JSON.parse(args.card),
        ),
      ),
  );
}
