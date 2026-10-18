import * as lark from "@larksuiteoapi/node-sdk";
import type { Config } from "./config.js";

// Never print SDK request objects: they can include authorization headers.
export const stderrLogger = Object.fromEntries(
  ["error", "warn", "info", "debug", "trace"].map((level) => [
    level,
    (..._args: unknown[]) => {
      if (level === "error" || level === "warn")
        process.stderr.write(
          `[lark-sdk] ${level}; inspect connection status\n`,
        );
    },
  ]),
) as any;

export function attachEventTransport(client: any, ingest: (raw: any) => any) {
  // The pinned SDK passes parsed, reassembled payloads to invoke. Keeping this
  // boundary generic accepts every event type, without per-type registrations.
  const dispatcher = new lark.EventDispatcher({ logger: stderrLogger });
  dispatcher.invoke = async (raw: any) => ingest(raw);
  // Same compatibility workaround as the original server: SDK 1.59 ignores
  // frames with type=card. Preserve reassembly and response handling in the SDK.
  if (typeof client.handleEventData !== "function")
    throw new Error("Unsupported Lark SDK: card frame hook missing");
  const original = client.handleEventData.bind(client);
  client.handleEventData = (frame: any) =>
    original({
      ...frame,
      headers: frame.headers?.map((h: any) =>
        h.key === "type" && h.value === "card" ? { ...h, value: "event" } : h,
      ),
    });
  return dispatcher;
}
export function startWs(cfg: Config, ingest: (raw: any) => any) {
  const client = new lark.WSClient({
    appId: cfg.appId,
    appSecret: cfg.appSecret!,
    domain: cfg.domain,
    logger: stderrLogger,
  });
  const dispatcher = attachEventTransport(client, ingest);
  let stopped = false,
    retry: ReturnType<typeof setTimeout> | undefined;
  const start = () => {
    void client.start({ eventDispatcher: dispatcher }).catch(() => {
      if (!stopped) retry = setTimeout(start, 5000);
    });
  };
  start();
  return {
    status: () => ({
      ...client.getReconnectInfo(),
      connected: (client as any).wsConfig.getWSInstance()?.readyState === 1,
    }),
    close: () => {
      stopped = true;
      clearTimeout(retry);
      client.close({ force: true });
    },
  };
}
