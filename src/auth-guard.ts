import { getBridge } from "./bridge.js";
import { withAuth } from "./client.js";
export function withModuleAuth<T>(_module: string, fn: () => Promise<T>) {
  return withAuth(async () => {
    await getBridge().call("token", { kind: "user" });
    return fn();
  });
}
