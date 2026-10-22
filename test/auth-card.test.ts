import test from "node:test";
import assert from "node:assert/strict";
import { patchAuthResultCard } from "../src/auth-card.js";

test("completed OAuth updates the sent card to green", async () => {
  let called = false;
  const request = async (url: string | URL | Request, init?: RequestInit) => {
    called = true;
    assert.equal(String(url), "https://open.feishu.cn/open-apis/im/v1/messages/om_test");
    assert.equal(init?.method, "PATCH");
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer tenant-token");
    const payload = JSON.parse(String(init?.body));
    const card = JSON.parse(payload.content);
    assert.equal(card.header.template, "green");
    assert.match(card.body.elements[0].content, /Authorization completed/);
    return Response.json({ code: 0 });
  };
  await patchAuthResultCard("https://open.feishu.cn", "om_test", "tenant-token", "authorized", request as typeof fetch);
  assert.equal(called, true);
});

test("ended OAuth updates the card to grey and reports API failures", async () => {
  const request = async (_url: unknown, init?: RequestInit) => {
    const card = JSON.parse(JSON.parse(String(init?.body)).content);
    assert.equal(card.header.template, "grey");
    return Response.json({ code: 230001, msg: "patch rejected" });
  };
  await assert.rejects(
    patchAuthResultCard("https://open.feishu.cn", "om_test", "tenant-token", "expired", request as typeof fetch),
    /patch rejected/,
  );
});
