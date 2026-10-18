import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { serve } from "../src/broker.js";
import { acquireWsLock, wsLockPath } from "../src/ws-lock.js";

test("one app-scoped WebSocket lease is held until release", async () => {
  const appId = `test-${randomUUID()}`;
  assert.equal(wsLockPath(appId), wsLockPath(appId));
  const first = await acquireWsLock(appId);
  assert.ok(first);
  const stateDir = mkdtempSync(join(tmpdir(), "lark-ws-lock-"));
  try {
    assert.equal(await acquireWsLock(appId), null);
    await assert.rejects(
      serve({
        appId,
        appSecret: "test-secret",
        domain: "https://open.feishu.cn",
        stateDir,
        socket: join(stateDir, "broker.sock"),
        continuous: false,
        graceMs: 1000,
        offline: false,
      }),
      /Another local process owns this app's Lark WebSocket/,
    );
  } finally {
    await first.release();
    rmSync(stateDir, { recursive: true, force: true });
  }
  const next = await acquireWsLock(appId);
  assert.ok(next);
  await next.release();
});
