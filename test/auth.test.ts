import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auth } from "../src/auth.js";
import type { Config } from "../src/config.js";

test("one refresh serves simultaneous sessions; imported source remains unchanged", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "lb-auth-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const original = JSON.stringify({
    app: { access_token: "old", refresh_token: "refresh", expires_at: 1 },
  });
  writeFileSync(join(dir, "import.json"), original);
  const cfg: Config = {
    appId: "app",
    appSecret: "test-secret",
    stateDir: dir,
    socket: join(dir, "s"),
    domain: "https://open.feishu.cn",
    tokenImport: join(dir, "import.json"),
    offline: false,
    continuous: false,
    graceMs: 1000,
  };
  let requests = 0;
  const mock = async () => {
    requests++;
    await new Promise((r) => setTimeout(r, 10));
    return Response.json({
      access_token: "new-access",
      refresh_token: "rotated-refresh",
      expires_in: 7200,
    });
  };
  const auth = new Auth(cfg, mock as typeof fetch);
  t.after(() => auth.close());
  assert.deepEqual(
    await Promise.all([auth.token("user"), auth.token("user")]),
    ["new-access", "new-access"],
  );
  assert.equal(requests, 1);
  assert.equal(readFileSync(cfg.tokenImport!, "utf8"), original);
  const saved = readFileSync(join(dir, "tokens.json"), "utf8");
  assert.equal(JSON.parse(saved).version, 2);
  assert.ok(!saved.includes("new-access"));
  const reopened = new Auth(
    { ...cfg, tokenImport: undefined },
    mock as typeof fetch,
  );
  t.after(() => reopened.close());
  assert.equal(await reopened.token("user"), "new-access");
  assert.equal(requests, 1);
});
test("failed refresh is retryable and tenant token requests are coalesced", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "lb-auth-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(
    join(dir, "tokens.json"),
    JSON.stringify({ access_token: "old", refresh_token: "r", expires_at: 0 }),
  );
  let count = 0;
  const mock = async (url: any) => {
    count++;
    if (String(url).includes("tenant_access_token"))
      return Response.json({
        code: 0,
        tenant_access_token: "tenant",
        expire: 7200,
      });
    return Response.json(
      count === 1
        ? { error: "temporary" }
        : { access_token: "valid", refresh_token: "r2", expires_in: 7200 },
    );
  };
  const auth = new Auth(
    {
      appId: "app",
      appSecret: "secret",
      stateDir: dir,
      socket: "",
      domain: "https://open.feishu.cn",
      offline: false,
      continuous: false,
      graceMs: 1000,
    },
    mock as typeof fetch,
  );
  t.after(() => auth.close());
  await assert.rejects(auth.token("user"));
  assert.equal(await auth.token("user"), "valid");
  assert.deepEqual(
    await Promise.all([auth.token("tenant"), auth.token("tenant")]),
    ["tenant", "tenant"],
  );
  assert.equal(count, 3);
});

test("concurrent OAuth initialization shares one flow and polling persists authorization", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "lb-oauth-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let starts = 0;
  const mock = async (url: any) => {
    if (String(url).includes("device_authorization")) {
      starts++;
      await new Promise((r) => setTimeout(r, 5));
      return Response.json({
        device_code: "device",
        verification_uri: "https://example.test/authorize",
        interval: 0,
        expires_in: 60,
      });
    }
    return Response.json({
      access_token: "authorized",
      refresh_token: "refresh",
      expires_in: 7200,
      scope: "offline_access test:read",
    });
  };
  const auth = new Auth(
    {
      appId: "app",
      appSecret: "secret",
      stateDir: dir,
      socket: "",
      domain: "https://open.feishu.cn",
      offline: false,
      continuous: false,
      graceMs: 1000,
    },
    mock as typeof fetch,
  );
  t.after(() => auth.close());
  const [a, b] = await Promise.all([
    auth.start("test:read"),
    auth.start("test:read"),
  ]);
  assert.equal(starts, 1);
  assert.equal(a.verification_url, b.verification_url);
  assert.ok(a.verification_url);
  await auth.tick();
  assert.equal(auth.status().oauth?.status, "authorized");
  assert.equal(await auth.token("user"), "authorized");
});
