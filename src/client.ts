import * as lark from "@larksuiteoapi/node-sdk";
import { getBridge } from "./bridge.js";
import { stderrLogger } from "./ws.js";

let client: lark.Client | undefined;
export function getLarkClient(): lark.Client {
  if (!client) {
    const bridge = getBridge();
    client = new lark.Client({
      appId: bridge.cfg.appId,
      appSecret: "broker-owned",
      domain: bridge.cfg.domain,
      logger: stderrLogger,
    });
    // Keep the original tools unchanged: their SDK requests still go directly
    // to Lark, but token acquisition is delegated to the shared broker.
    const manager = (client as any).tokenManager;
    if (!manager || typeof manager.getTenantAccessToken !== "function")
      throw new Error("Unsupported Lark SDK token manager");
    manager.getTenantAccessToken = async () =>
      (await bridge.call("token", { kind: "tenant" })).token;
  }
  return client;
}
export async function asUser() {
  return lark.withUserAccessToken(
    (await getBridge().call("token", { kind: "user" })).token,
  );
}
export function assertOk(res: any) {
  if (res.code !== undefined && res.code !== 0)
    throw new Error(`Lark API ${res.code}: ${res.msg}`);
}
export async function withAuth<T>(fn: () => Promise<T>) {
  try {
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(await fn(), null, 2) },
      ],
    };
  } catch (e: any) {
    return {
      isError: true,
      content: [{ type: "text" as const, text: e.message ?? "Request failed" }],
    };
  }
}
