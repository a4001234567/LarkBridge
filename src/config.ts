import { readFileSync, mkdirSync, chmodSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

export type Config = {
  appId: string;
  appSecret?: string;
  domain: string;
  stateDir: string;
  socket: string;
  tokenImport?: string;
  continuous: boolean;
  graceMs: number;
  offline: boolean;
  postToolInjection?: boolean;
};
export function config(): Config {
  const local = fileURLToPath(new URL("../.codex/local-config.json", import.meta.url));
  const file = process.env.LARK_BRIDGE_CONFIG ?? (existsSync(local) ? local : undefined);
  const saved = file ? JSON.parse(readFileSync(file, "utf8")) : {};
  const appId = process.env.LARK_APP_ID ?? saved.appId;
  if (!appId) throw new Error("Set LARK_APP_ID or LARK_BRIDGE_CONFIG");
  const key = createHash("sha256").update(appId).digest("hex").slice(0, 16);
  const stateDir =
    process.env.LARK_BRIDGE_STATE_DIR ??
    saved.stateDir ??
    join(homedir(), ".local", "state", "lark-bridge", key);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  chmodSync(stateDir, 0o700);
  return {
    appId,
    appSecret: process.env.LARK_APP_SECRET ?? saved.appSecret,
    domain: saved.domain ?? "https://open.feishu.cn",
    stateDir,
    socket: join(stateDir, "broker.sock"),
    tokenImport: process.env.LARK_BRIDGE_IMPORT_TOKENS ?? saved.tokenImport,
    continuous: saved.continuous === true,
    graceMs: saved.graceMs ?? 60_000,
    offline: process.env.LARK_BRIDGE_OFFLINE === "1",
    postToolInjection: saved.postToolInjection !== false,
  };
}
