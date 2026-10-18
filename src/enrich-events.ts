import { messageText, type ClaimedEvent } from "./format-events.js";

/** Expand a forwarded chat-history message before exposing it to an agent. */
export async function expandForwardedEvents(
  events: ClaimedEvent[],
  getMessage: (messageId: string) => Promise<any>,
): Promise<ClaimedEvent[]> {
  return Promise.all(events.map(async (item) => {
    const raw = item.payload ?? {};
    const event = raw.event ?? raw;
    const message = event.message;
    if (item.type !== "im.message.receive_v1" || message?.message_type !== "merge_forward" || !message.message_id)
      return item;
    try {
      const response = await getMessage(message.message_id);
      if (response?.code !== undefined && response.code !== 0) throw new Error("Lark message lookup failed");
      const children = response?.data?.items;
      if (!Array.isArray(children)) return item;
      const parentTime = Number(message.create_time);
      const forwarded = children.filter((child: any) =>
        child.message_id !== message.message_id &&
        (!Number.isFinite(parentTime) || !Number.isFinite(Number(child.create_time)) || Number(child.create_time) < parentTime));
      const shown = forwarded.slice(0, 20);
      const lines: string[] = [];
      let previousSender: string | undefined;
      for (const child of shown) {
        const sender = child.sender?.id ?? child.sender?.sender_id?.open_id ?? "unknown";
        if (sender !== previousSender) lines.push(`user: ${sender}`);
        previousSender = sender;
        const body = messageText({
          message_type: child.msg_type,
          content: child.body?.content,
          message_id: message.message_id,
          mentions: child.mentions,
        }).replaceAll("\n", " ");
        lines.push(`  ${body.slice(0, 1000)}`);
      }
      const omitted = forwarded.length - shown.length;
      const display = `[forwarded chat history: ${forwarded.length} messages, message_id=${message.message_id}]` +
        (lines.length ? `\n${lines.join("\n")}` : "") +
        (omitted ? `\n... ${omitted} more; use feishu_im_get_message for the full history` : "");
      const enriched = { ...message, display_content: display };
      return {
        ...item,
        payload: raw.event ? { ...raw, event: { ...event, message: enriched } } : { ...raw, message: enriched },
      };
    } catch {
      return item;
    }
  }));
}
