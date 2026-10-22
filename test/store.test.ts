import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";

const message = (
  id: string,
  chat = "oc_one",
  type = "im.message.receive_v1",
) => ({
  schema: "2.0",
  header: { event_id: id, event_type: type },
  event: { message: { chat_id: chat, content: '{"text":"你好"}' } },
});
const click = (id: string, chat = "oc_one", interaction = "card") => ({
  schema: "2.0",
  header: { event_id: id, event_type: "card.action.trigger" },
  event: {
    context: { open_chat_id: chat, open_message_id: "om_card" },
    operator: { open_id: "ou_user" },
    action: {
      value: { action: "confirm", bridge_interaction_id: interaction },
    },
  },
});
function setup(t: any) {
  const dir = mkdtempSync(join(tmpdir(), "lb-store-"));
  let s = new Store(dir);
  t.after(() => {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    get s() {
      return s;
    },
    restart() {
      s.close();
      s = new Store(dir);
      return s;
    },
  };
}

test("chat-only routing, released claims invalidate old receipts, dedupe survives restart", (t) => {
  const fixture = setup(t);
  let { s } = fixture;
  s.register("a", "A", "mcp");
  s.register("b", "B", "mcp");
  s.route("oc_one", "a");
  s.ingest(message("one"));
  s.ingest(message("two", "oc_two"));
  s.ingest(message("generic", "oc_one", "custom.future.event"));
  const first = s.claim("a");
  assert.equal(first.length, 2);
  assert.equal(s.claim("b").length, 0);
  assert.throws(() => s.route("oc_one", "b"), /held by live session a/);
  s.subscribe("a", "only", []);
  s.route("oc_one", "b");
  assert.throws(() => s.ack("a", first[0].id, first[0].receipt));
  const second = s.claim("b");
  assert.equal(second.length, 2);
  s.ack("b", second[0].id, second[0].receipt);
  s = fixture.restart();
  assert.equal(s.ingest(message("one")).duplicate, true);
  s.register("b", "B", "mcp");
  assert.equal(s.claim("b").length, 1);
  s.route("oc_two", "b");
  assert.equal(s.claim("b").length, 1);
});
test("all and all-except filters include every event type and partition chats", (t) => {
  const { s } = setup(t);
  s.register("a", "A", "mcp");
  s.register("b", "B", "mcp");
  s.subscribe("a", "all_except", ["oc_private"]);
  s.subscribe("b", "only", ["oc_private"]);
  assert.throws(() => s.route("oc_one", "b"), /held by live session a/);
  s.ingest(message("ordinary", "oc_one"));
  s.ingest(message("future", "oc_new", "custom.future.event"));
  s.ingest(message("private", "oc_private"));
  s.ingest(click("card", "oc_one"));
  assert.deepEqual(s.claim("a").map(event => event.id), ["ordinary", "future", "card"]);
  assert.deepEqual(s.claim("b").map(event => event.id), ["private"]);
  assert.throws(() => s.subscribe("a", "all", []), /held by live session b/);
  s.subscribe("b", "only", []);
  s.subscribe("a", "all", []);
  assert.deepEqual(s.claim("a").map(event => event.id), ["private"]);
});
test("only filters are exclusive while live and released when a session disconnects", (t) => {
  const { s } = setup(t);
  s.register("a", "A", "mcp");
  s.register("b", "B", "mcp");
  s.subscribe("a", "only", ["oc_one", "oc_two"]);
  s.subscribe("b", "only", ["oc_three"]);
  assert.throws(() => s.subscribe("b", "only", ["oc_two"]), /held by live session a/);
  s.ingest(message("one", "oc_one"));
  const [leased] = s.claim("a");
  s.disconnect("a");
  s.subscribe("b", "only", ["oc_one", "oc_three"]);
  assert.throws(() => s.ack("a", leased.id, leased.receipt), /reassigned/);
  assert.equal(s.claim("b")[0].id, "one");
  s.register("a", "A", "mcp");
  assert.deepEqual(s.list().subscriptions.find((item: any) => item.session === "a")?.chats, ["oc_two"]);
});
test("a broad filter does not reclaim chats held when its session reconnects", (t) => {
  const { s } = setup(t);
  s.register("a", "A", "mcp");
  s.subscribe("a", "all", []);
  s.disconnect("a");
  s.register("b", "B", "mcp");
  s.subscribe("b", "only", ["oc_one"]);
  assert.equal(s.register("a", "A", "mcp").subscription_dropped, true);
  s.ingest(message("one", "oc_one"));
  assert.deepEqual(s.claim("a"), []);
  assert.equal(s.claim("b")[0].id, "one");
  assert.equal(s.list().subscriptions.some((item: any) => item.session === "a"), false);
});
test("pause, disconnect and expired leases retain events", (t) => {
  const { s } = setup(t);
  s.register("a", "A", "mcp");
  s.route("oc_one", "a");
  s.ingest(message("event"));
  s.pause("a", true);
  assert.deepEqual(s.claim("a"), []);
  s.pause("a", false);
  const [first] = s.claim("a");
  s.db.exec("UPDATE events SET lease_until=0");
  assert.throws(() => s.ack("a", first.id, first.receipt));
  const [second] = s.claim("a");
  assert.notEqual(second.receipt, first.receipt);
  s.disconnect("a");
  assert.deepEqual(s.claim("a"), []);
  s.register("a", "A", "mcp");
  assert.equal(s.claim("a").length, 1);
});
test("p2p chat metadata carries from messages to card callbacks", (t) => {
  const { s } = setup(t);
  s.register("a", "A", "mcp");
  s.route("oc_one", "a");
  const incoming: any = message("p2p");
  incoming.event = {
    ...incoming.event,
    message: { ...incoming.event.message, chat_type: "p2p" },
    sender: { sender_id: { open_id: "ou_user" } },
  };
  s.ingest(incoming);
  s.ingest(click("clicked"));
  const [msg, card] = s.claim("a");
  assert.deepEqual([msg.chat_type, msg.peer_id], ["p2p", "ou_user"]);
  assert.deepEqual([card.chat_type, card.peer_id], ["p2p", "ou_user"]);
  assert.equal(s.chatForPeer("ou_user"), "oc_one");
  assert.throws(() => s.chatForPeer("ou_missing"), /No known p2p chat/);
  assert.equal(s.raw("a", undefined, card.receipt).id, "clicked");
  s.ack("a", undefined, card.receipt);
  assert.throws(() => s.raw("a", undefined, card.receipt), /expired/);
});
test("known p2p chats are restored from events after upgrading the store", (t) => {
  const fixture = setup(t);
  const incoming: any = message("older");
  incoming.event.message.chat_type = "p2p";
  incoming.event.sender = { sender_id: { open_id: "ou_user" } };
  fixture.s.ingest(incoming);
  fixture.s.db.exec("DELETE FROM chats");
  assert.equal(fixture.restart().chatForPeer("ou_user"), "oc_one");
});
test("card correlation works before bind; chat routing wins over sending session", (t) => {
  const { s } = setup(t);
  s.register("sender", "Sender", "mcp");
  s.register("recipient", "Recipient", "mcp");
  s.route("oc_one", "recipient");
  s.interaction({
    id: "card",
    chat_id: "oc_one",
    expires_at: Date.now() + 60_000,
    kind: "confirm",
    data: { title: "Proceed?", confirm_label: "Yes", cancel_label: "No" },
  });
  const result = s.ingest(click("click"));
  assert.equal(result.response.card.type, "raw");
  s.bind("card", "om_card");
  assert.deepEqual(s.ingest(click("click")).response, result.response);
  assert.equal(s.claim("sender").length, 0);
  assert.equal(s.claim("recipient").length, 1);
  assert.equal(s.getInteraction("card").status, "responded");
  const second = s.ingest(click("click2"));
  assert.equal(second.response.card, undefined);
});
test("card registration cannot affect another chat; expired actions remain events", (t) => {
  const { s } = setup(t);
  s.register("a", "A", "mcp");
  s.route("oc_two", "a");
  s.route("oc_one", "a");
  s.interaction({
    id: "card",
    chat_id: "oc_one",
    expires_at: Date.now() - 1,
    kind: "custom",
    data: {},
    responses: { confirm: { toast: { type: "success", content: "approved" } } },
  });
  assert.notEqual(
    s.ingest(click("other", "oc_two")).response.toast.content,
    "approved",
  );
  s.expire();
  assert.equal(s.getInteraction("card").status, "expired");
  s.ingest(click("expired"));
  assert.equal(s.claim("a").length, 2);
});
test("blocking-card fetch selects only its card without draining other events", (t) => {
  const { s } = setup(t);
  s.register("a", "A", "mcp");
  s.route("oc_one", "a");
  for (let i = 0; i < 150; i++) s.ingest(message("normal" + i));
  s.ingest(click("card-event"));
  assert.equal(s.claim("a", 1, "card")[0].id, "card-event");
  assert.equal(s.claim("a")[0].id, "normal0");
});
test("progress stop response is immediate and persists independently of delivery", (t) => {
  const { s } = setup(t);
  s.interaction({
    id: "card",
    chat_id: "oc_one",
    expires_at: Date.now() + 60_000,
    kind: "progress",
    data: {
      title: "Work",
      steps: [{ label: "One" }, { label: "Two" }],
      currentStep: 0,
    },
  });
  s.bind("card", "om_card");
  s.updateProgress("om_card", 1, [{ index: 1, detail: "In progress" }]);
  const event = click("stop");
  event.event.action.value.action = "stop";
  const result = s.ingest(event);
  assert.ok(result.response.card);
  assert.equal(s.updateProgress("om_card", 2, []).status, "responded");
});
