---
name: lark-tool-design
description: Design or review Lark Bridge MCP tool interfaces when adding, changing, or consolidating agent-facing tools. Use for tool names, arguments, results, and auth boundaries; not for routine calls to existing tools.
---

# Lark Bridge tool design

Keep the agent-facing surface small and predictable. Start with the user action the tool enables; add a tool only when an existing operation cannot express that action clearly. The Calendar and Task modules in `src/tools/calendar.ts` and `src/tools/task.ts` are the current baseline: `create`, `list`, `patch`, and `delete`, with separate task-list operations because lists are a distinct resource.

When designing or reviewing a tool:

- Prefer a concrete verb and resource in the name. Require only the fields needed for that operation; make optional fields genuinely optional. Reuse familiar field names and time formats across related tools.
- Return a compact, usable result: the stable full identifier after creation, items and an honest count for a list, and the identifier plus changed fields or deletion status for a mutation. Display formatting must not replace an identifier needed by a later tool call.
- Make scope explicit where one identifier can mean different things. For recurring calendar events, distinguish a series from an occurrence and avoid returning abbreviated occurrence IDs as if they were actionable.
- Keep OAuth, token refresh, and the Lark connection behind the broker. The stdio MCP server obtains a token from the broker and makes outbound Lark API calls directly; ordinary tool arguments should describe the user's action, not transport or auth mechanics. Messaging tools remain independent of inbound delivery.
- Use the same MCP contract as existing tools: validated JSON-object arguments, JSON serialized into MCP text results, clear tool errors, and an authorization URL when user OAuth is needed.
- For list tools, make the result's coverage clear. If it is only one page, expose continuation or clearly report that limitation; do not imply the returned `count` is a total across unseen pages.

Before adding a wrapper, mode, or option, check whether it removes a concrete ambiguity or repeated agent step. Preserve the simple interface when the extra abstraction only mirrors Lark's API. Inspect neighboring tools and update `README.md` or `DESIGN.md` when the public contract or architectural boundary changes.
