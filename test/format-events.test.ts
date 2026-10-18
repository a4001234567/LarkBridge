import test from "node:test";
import assert from "node:assert/strict";
import { formatEvents, type ClaimedEvent } from "../src/format-events.js";

const base = {
  chat_id: "oc_chat",
  received_at: Date.parse("2026-10-17T12:00:00Z"),
  receipt: "lease-1",
};

test("compact event view shows p2p sender without delivery metadata", () => {
  const message: ClaimedEvent = {
    ...base,
    chat_type: "p2p",
    peer_id: "ou_user",
    id: "event-1",
    type: "im.message.receive_v1",
    payload: { event: {
      sender: { sender_id: { open_id: "ou_user" } },
      message: { message_id: "om_message", chat_id: "oc_chat", message_type: "text", content: '{"text":"hi？"}' },
    } },
  };
  const click: ClaimedEvent = {
    ...base,
    chat_type: "p2p",
    peer_id: "ou_user",
    id: "event-2",
    receipt: "lease-2",
    type: "card.action.trigger",
    payload: { event: {
      context: { open_chat_id: "oc_chat", open_message_id: "om_card" },
      operator: { open_id: "ou_user" },
      action: { value: { action: "confirm", bridge_interaction_id: "card-1" } },
    } },
  };
  const result = formatEvents([message, click]);
  assert.match(result, /^user: ou_user/m);
  assert.match(result, /"hi？"/);
  assert.match(result, /\[card\] confirm/);
  assert.doesNotMatch(result, /oc_chat|om_message|om_card|event-1|event-2|bridge_interaction_id|receipt|lease-1|lease-2/);
  assert.equal(result.includes('"schema"'), false);
});

test("unknown event types remain visible and empty batches are explicit", () => {
  assert.equal(formatEvents([]), "No pending Lark events.");
  const result = formatEvents([{
    ...base, id: "future-1", type: "future.event",
    payload: { event: { chat_id: "oc_chat", value: 42 } },
  }]);
  assert.match(result, /\[future.event\].*"value":42/);
  assert.match(result, /chat: oc_chat/);
  assert.doesNotMatch(result, /receipt|lease-1/);
  assert.doesNotMatch(result, /future-1/);
});

test("group messages are grouped by sender, then sorted by time", () => {
  const make = (id: string, user: string, iso: string, text: string): ClaimedEvent => ({
    ...base,
    id,
    receipt: `lease-${id}`,
    chat_type: "group",
    received_at: Date.parse(iso),
    type: "im.message.receive_v1",
    payload: { event: {
      sender: { sender_id: { open_id: user } },
      message: { chat_id: "oc_chat", chat_type: "group", message_type: "text", create_time: String(Date.parse(iso)), content: JSON.stringify({ text }) },
    } },
  });
  const result = formatEvents([
    make("a-late", "ou_alice", "2026-10-17T06:03:00Z", "later"),
    make("b", "ou_bob", "2026-10-17T06:02:00Z", "bob"),
    make("a-early", "ou_alice", "2026-10-17T06:01:00Z", "earlier"),
    make("a-next", "ou_alice", "2026-10-18T06:04:00Z", "next day"),
  ]);
  assert.match(result, /^chat: oc_chat\n  user: ou_alice\n    2026-10-17 14:01  "earlier"\n    14:03  "later"\n    2026-10-18 14:04  "next day"\n  user: ou_bob\n    2026-10-17 14:02  "bob"$/);
  assert.equal(result.match(/user: ou_alice/g)?.length, 1);
  assert.equal(result.match(/chat: oc_chat/g)?.length, 1);
});

test("mentions and attachment types retain the details needed to act", () => {
  const make = (id: string, message_type: string, body: any, extras: any = {}): ClaimedEvent => ({
    ...base, id, type: "im.message.receive_v1", receipt: `lease-${id}`,
    payload: { event: {
      sender: { sender_id: { open_id: "ou_user" } },
      message: { message_id: `om_${id}`, chat_id: "oc_chat", message_type, content: JSON.stringify(body), ...extras },
    } },
  });
  const result = formatEvents([
    make("mention", "text", { text: "Hi @_user_1" }, { mentions: [{ key: "@_user_1", name: "Bot", id: { open_id: "ou_bot" } }] }),
    make("audio", "audio", { file_key: "file_voice" }),
    make("file", "file", { file_key: "file_doc", file_name: "report.pdf" }),
    make("card", "interactive", { header: { title: { content: "Approve?" } }, body: { elements: [{ tag: "markdown", content: "Review the report" }] } }),
    make("forward", "merge_forward", {}),
  ]);
  assert.match(result, /"Hi @Bot\(ou_bot\)"/);
  assert.match(result, /\[audio file_key=file_voice message_id=om_audio\]/);
  assert.match(result, /\[file file_key=file_doc name="report.pdf" message_id=om_file\]/);
  assert.match(result, /\[card "Approve\?" \| "Review the report" message_id=om_card\]/);
  assert.match(result, /\[forwarded chat history message_id=om_forward\]/);
});
