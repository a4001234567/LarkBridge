import test from "node:test";
import assert from "node:assert/strict";
import { setBridge, type Bridge } from "../src/bridge.js";
import { withModuleAuth } from "../src/auth-guard.js";

test("people search waits for user OAuth instead of using an app token", async () => {
  const calls: Array<{ method: string; params: any }> = [];
  setBridge({ call: async (method: string, params: any = {}) => {
    calls.push({ method, params });
    if (method === "auth_status") return { authenticated: false, scopes: [] };
    if (method === "auth_start") return { verification_url: "https://example.test/authorize", status: "pending" };
    throw new Error(`Unexpected ${method}`);
  } } as unknown as Bridge);
  let ran = false;
  const result = await withModuleAuth("people", async () => { ran = true; return {}; });
  assert.equal(ran, false);
  assert.equal(JSON.parse(result.content[0].text).verification_url, "https://example.test/authorize");
  assert.deepEqual(calls.map(call => call.method), ["auth_status", "auth_start"]);
});
