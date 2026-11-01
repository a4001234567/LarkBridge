import { getBridge } from "./bridge.js";
import { withAuth } from "./client.js";

export const MODULE_SCOPES: Record<string, string[]> = {
  calendar: [
    "calendar:calendar:read", "calendar:calendar.event:create",
    "calendar:calendar.event:delete", "calendar:calendar.event:read",
    "calendar:calendar.event:reply", "calendar:calendar.event:update",
    "calendar:calendar.free_busy:read",
  ],
  task: [
    "task:task:read", "task:task:write", "task:task:writeonly",
    "task:tasklist:read", "task:tasklist:write",
  ],
  docs: [
    "docx:document:readonly", "docx:document:create",
    "docx:document:write_only", "docx:document.block:convert", "search:docs:read",
    "space:document:delete", "space:document:move",
    "space:document:retrieve", "drive:drive.metadata:readonly",
    "drive:file:download", "drive:file:upload",
    "docs:document:export", "docs:document.media:download",
    "docs:document.media:upload", "docs:document:copy",
    "wiki:member:create", "wiki:node:copy", "wiki:node:create",
    "wiki:node:move", "wiki:node:read", "wiki:node:retrieve",
    "wiki:space:read", "wiki:space:retrieve",
    "wiki:space:write_only", "wiki:wiki",
  ],
};

export function scopesForModule(module: string) {
  return module === "all"
    ? [...new Set(Object.values(MODULE_SCOPES).flat())]
    : MODULE_SCOPES[module] ?? [];
}

/** User OAuth is shared by the broker. */
export function withModuleAuth<T>(module: string, fn: () => Promise<T>) {
  return withAuth(async () => {
    const bridge = getBridge();
    const status = await bridge.call("auth_status");
    const required = MODULE_SCOPES[module] ?? [];
    const granted: string[] = status.scopes ?? [];
    // Imported credentials may have no recorded scope metadata; let Lark
    // decide whether an individual API is permitted in that case.
    if (status.authenticated && (!granted.length || required.every(scope => granted.includes(scope))))
      return fn();
    const oauth = await bridge.call("auth_start", { scope: required.join(" ") });
    return {
      authorization_required: true,
      module,
      verification_url: oauth.verification_url,
      status: oauth.status,
      message: "Authorize in Lark, then retry this tool.",
    };
  });
}
