---
name: lark-mcp-guide
description: Orient an agent to Lark Bridge tools, identifiers, authentication, and event delivery when choosing a tool or starting a Lark task.
---

# Lark Bridge guide

This is the personal Lark MCP surface from the original server, now attached to a shared inbound broker. The broker owns the single long connection, chat-to-session routing, event buffering, and OAuth tokens. Each stdio MCP server exposes outbound tools; it gets tokens from the broker and calls Lark directly.

## Identifiers

- `ou_xxx`: user `open_id`; use for direct messages and task assignment.
- `oc_xxx`: chat ID; use for group messages and registered interactive cards. Card actions route to the session assigned to the card's originating chat.
- `om_xxx`: message ID; use to reply, edit, or fetch an attachment. `feishu_im_send` accepts it as `receive_id` for replies.
- Calendar `event_id` and Task `task_guid` identify those resources; keep full IDs for later changes.

## Auth and modules

`feishu_auth_init` starts user OAuth and returns a verification URL without blocking. `feishu_auth_status` reports progress; `feishu_auth_whoami` identifies the user. Calendar, Task, People search, and most document operations use the broker's user token. A tool that needs missing authorization returns a verification URL; authorize and retry. App messaging uses a tenant token.

Use the corresponding module prompt for details: `feishu-im`, `feishu-interactive-cards`, `feishu-calendar`, `feishu-task`, `feishu-people`, or `feishu-doc`. `feishu-watch-loop` explains the Bridge's inbound message loop and chat subscriptions. Incoming messages and callbacks are delivered by the broker; this server does not expose the old `feishu_im_watch` blocking receiver. Scheduled reminders use `feishu_schedule_*`.
