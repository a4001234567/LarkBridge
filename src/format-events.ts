export type ClaimedEvent = {
  id: string;
  chat_id: string;
  chat_type?: string | null;
  peer_id?: string | null;
  type: string;
  payload: any;
  received_at: number;
  receipt: string;
};

function time(ms: unknown): string {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return "time unknown";
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(value));
}

function content(value: unknown): any {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
}

function mentions(text: string, entries: any): string {
  if (!Array.isArray(entries)) return text;
  let result = text;
  for (const mention of entries) {
    if (typeof mention?.key !== "string" || !mention.key) continue;
    const id = mention.id?.open_id ?? mention.id?.user_id ?? mention.open_id;
    const name = mention.name ?? id ?? mention.key;
    const label = `@${name}${id && name !== id ? `(${id})` : ""}`;
    result = result.split(mention.key).join(label);
  }
  return result;
}

export function messageText(message: any): string {
  const body = content(message.content);
  const type = message.message_type ?? message.msg_type ?? "unknown";
  if (type === "text")
    return JSON.stringify(mentions(typeof body === "string" ? body : body?.text ?? "", message.mentions));
  if (type === "merge_forward")
    return message.display_content ?? `[forwarded chat history message_id=${message.message_id ?? "?"}]`;
  if (type === "image")
    return `[image image_key=${body?.image_key ?? "?"} message_id=${message.message_id ?? "?"}]`;
  if (["audio", "file", "media"].includes(type))
    return `[${type} file_key=${body?.file_key ?? "?"}${body?.file_name ? ` name=${JSON.stringify(body.file_name)}` : ""} message_id=${message.message_id ?? "?"}]`;
  if (type === "interactive") {
    // Lark's flattened card content may contain only a client-upgrade fallback.
    // The original schema 2.0 card is preserved as a JSON string in user_dsl.
    const dsl = content(body?.user_dsl);
    const card = dsl && typeof dsl === "object" && !Array.isArray(dsl) ? dsl : body;
    const texts: string[] = [];
    const collect = (node: any, depth = 0) => {
      if (!node || depth > 12 || texts.length >= (card === body ? 12 : 2)) return;
      if (Array.isArray(node)) { for (const child of node) collect(child, depth + 1); return; }
      if (typeof node !== "object") return;
      if (typeof node.content === "string" && node.content.trim()) texts.push(node.content.trim());
      else if (typeof node.text === "string" && node.text.trim()) texts.push(node.text.trim());
      for (const key of ["header", "title", "body", "elements", "fields", "actions", "text"])
        if (typeof node[key] === "object") collect(node[key], depth + 1);
    };
    collect(card);
    const summary = texts.map(text => JSON.stringify(text.slice(0, 300))).join(" | ") ||
      (card?.data?.template_id ? `template=${card.data.template_id}` : "");
    return `[card${summary ? ` ${summary}` : ""} message_id=${message.message_id ?? "?"}]`;
  }
  return typeof body === "string" ? JSON.stringify(body) : JSON.stringify(body ?? {});
}

/** The agent sees message content and source; delivery tokens stay with the mediator. */
export function formatEvents(events: ClaimedEvent[]): string {
  if (!events.length) return "No pending Lark events.";
  type Line = { at: number; order: number; body: string };
  type Source = { actor?: string; lines: Line[] };
  type Chat = { type?: string | null; sources: Map<string, Source> };
  const chats = new Map<string, Chat>();
  for (const [order, item] of events.entries()) {
    const raw = item.payload ?? {};
    const event = raw.event ?? raw;
    const isMessage = item.type === "im.message.receive_v1" && event.message;
    const isCard = item.type === "card.action.trigger";
    const chatType = item.chat_type ?? (isMessage ? event.message.chat_type : undefined);
    let chat = chats.get(item.chat_id);
    if (!chat) {
      chat = { type: chatType, sources: new Map() };
      chats.set(item.chat_id, chat);
    } else if (!chat.type && chatType) chat.type = chatType;
    const actor = (isMessage
      ? event.sender?.sender_id?.open_id ?? event.sender?.sender_id?.user_id
      : isCard ? event.operator?.open_id : undefined) ?? item.peer_id;
    const sourceKey = actor ?? "";
    let source = chat.sources.get(sourceKey);
    if (!source) {
      source = { actor, lines: [] };
      chat.sources.set(sourceKey, source);
    }
    let body: string;
    let at = Number(item.received_at);
    if (isMessage) {
      const message = event.message;
      at = Number(message.create_time ?? item.received_at);
      body = messageText(message);
    } else if (isCard) {
      const action = event.action ?? {};
      const value = action.value ?? {};
      const name = value.action ?? (action.form_value ? "form_submit" : "unknown");
      const { action: _action, bridge_interaction_id: _interaction, ...details } = value;
      body = `[card] ${name}${Object.keys(details).length ? `  value: ${JSON.stringify(details)}` : ""}${action.form_value ? `  form: ${JSON.stringify(action.form_value)}` : ""}`;
    } else {
      body = `[${item.type}] ${JSON.stringify(event)}`;
    }
    source.lines.push({ at: Number.isFinite(at) && at > 0 ? at : Number(item.received_at), order, body });
  }
  return [...chats].map(([chatId, chat]) => {
    const sources = [...chat.sources.values()];
    for (const source of sources) source.lines.sort((a, b) => a.at - b.at || a.order - b.order);
    sources.sort((a, b) => a.lines[0].at - b.lines[0].at || a.lines[0].order - b.lines[0].order);
    const p2p = chat.type === "p2p" && sources.length === 1 && !!sources[0].actor;
    const blocks = sources.map((source) => {
      let previousDate: string | undefined;
      const lines = source.lines.map((line) => {
        const stamp = time(line.at);
        const date = stamp.slice(0, 10);
        const shownTime = date === previousDate ? stamp.slice(-5) : stamp;
        previousDate = date;
        const indent = p2p ? "  " : "    ";
        return `${indent}${shownTime}  ${line.body.replaceAll("\n", `\n${indent}  `)}`;
      });
      return p2p ? lines.join("\n") : [`  user: ${source.actor ?? "unknown"}`, ...lines].join("\n");
    });
    return [p2p ? `user: ${sources[0].actor}` : `chat: ${chatId}`, ...blocks].join("\n");
  }).join("\n\n");
}
