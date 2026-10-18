import test from "node:test";
import assert from "node:assert/strict";
import { expandForwardedEvents } from "../src/enrich-events.js";
import { formatEvents, type ClaimedEvent } from "../src/format-events.js";

test("forwarded chat history expands with the container ID for attachments", async () => {
  const event: ClaimedEvent = {
    id: "forward", chat_id: "oc_chat", chat_type: "group", type: "im.message.receive_v1",
    received_at: 3000, receipt: "internal",
    payload: { event: {
      sender: { sender_id: { open_id: "ou_sender" } },
      message: { message_id: "om_forward", chat_id: "oc_chat", message_type: "merge_forward", create_time: "3000", content: "{}" },
    } },
  };
  const [expanded] = await expandForwardedEvents([event], async id => {
    assert.equal(id, "om_forward");
    return { data: { items: [
      { message_id: "om_child", create_time: "1000", sender: { id: "ou_alice" }, msg_type: "text", body: { content: '{"text":"hello"}' } },
      { message_id: "om_child2", create_time: "1500", sender: { id: "ou_alice" }, msg_type: "text", body: { content: '{"text":"again"}' } },
      { message_id: "om_image", create_time: "2000", sender: { id: "ou_bob" }, msg_type: "image", body: { content: '{"image_key":"img_1"}' } },
      { message_id: "om_forward", create_time: "3000", msg_type: "merge_forward" },
    ] } };
  });
  const shown = formatEvents([expanded]);
  assert.match(shown, /\[forwarded chat history: 3 messages, message_id=om_forward\]/);
  assert.match(shown, /user: ou_alice\n\s+"hello"\n\s+"again"/);
  assert.match(shown, /user: ou_bob\n\s+\[image image_key=img_1 message_id=om_forward\]/);
  assert.equal(shown.match(/user: ou_alice/g)?.length, 1);
  assert.doesNotMatch(shown, /receipt|internal|om_child/);
  assert.deepEqual(event.payload.event.message.content, "{}");
});
