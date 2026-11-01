---
name: feishu-interactive-cards
description: |
    Interactive cards for confirm dialogs, input forms, and multi-step progress trackers.
    Use it when:
        You need to acquire consent for dangerous/non-recoverable operations;
        Structural information are to be acquired from user or sensitive information;
        Entering Multistage task or complex plan and you need to provide realtime update.

---

# Interactive Cards

Three card types — each sends a card that updates itself inline after the user interacts.

---

## Confirm Card — `feishu_im_send_confirm`

Present a yes/no decision. Use `blocking=true` to wait for the click when that fits the current turn; `blocking=false` (default) returns immediately. The broker routes the later action to the session assigned to the originating chat.

Registered cards require a chat ID (`oc_xxx`) as `receive_id` so callbacks can follow that chat's subscription. A card click may arrive during a later turn; keep enough context in the conversation to handle it.
Use this Bridge's card tools for registered interactions. A card sent by a separate legacy MCP process has no interaction record in the Bridge broker, even if the Bridge receives its click; the click can reach the agent without the expected inline card update.

| Param | Default | Notes |
|-------|---------|-------|
| `title` | required | Card heading |
| `body` | — | Markdown body text |
| `confirm_label` | `确认` | Confirm button text |
| `cancel_label` | `取消` | Cancel button text |
| `blocking` | `false` | Wait for click before returning |
| `timeout_seconds` | `3600` | Card expires after N seconds |

---

## Form Card — `feishu_im_send_form`

Collect structured input via text fields. Use `blocking=true` to wait for submission; with the default `blocking=false`, the submitted `form_value` arrives as a chat-routed event.

Each field: `name` (result key), `label`, `placeholder?`, `required?`, `hidden?` (password input — shows `******` after submit).

| Param | Default | Notes |
|-------|---------|-------|
| `title` | required | Card heading |
| `body` | — | Markdown text above the fields |
| `fields` | required | Array of field definitions (min 1) |
| `submit_label` | `提交` | Submit button text |
| `blocking` | `false` | Wait for submission before returning |
| `timeout_seconds` | `3600` | Card expires after N seconds |

---

## Progress Card — `feishu_im_send_progress` + `feishu_im_patch_progress`

Show a multi-step task as collapsible steps with a **Stop button** while active. Send once, then patch after each step. Pass `current_step = steps.length` to mark complete (green header).

Each step: `label` + optional `detail`. Every step stays in a panel. A step without detail has an empty body and no chevron; a non-empty detail appears when expanded. Give each planned step a short, useful explanation when you know one, and update it as work progresses. Do not repeat the label as detail.

**`feishu_im_send_progress` params:**

| Param | Notes |
|-------|-------|
| `receive_id` | Destination (ou_xxx or oc_xxx) |
| `title` | Card heading (cached server-side — do not repeat on patch) |
| `steps` | Ordered array of `{ label, detail? }` (cached server-side — do not repeat on patch) |
| `current_step` | 0-based active step; default 0 |

**`feishu_im_patch_progress` params** — `title` and `steps` are cached; only pass what changes:

| Param | Notes |
|-------|-------|
| `message_id` | Returned by `feishu_im_send_progress` |
| `session_id` | Optional Codex session ID to also drain ready Lark messages |
| `current_step` | 0-based active step; `steps.length` = completed |
| `step_updates` | Optional `[{ index, detail }]` — update detail text on specific steps |

**Stop button:** The card shows a red Stop button while in progress. If the user presses it:
- The card immediately updates to grey "已停止"
- The stop event is routed to the chat-assigned session
- The next `feishu_im_patch_progress` call returns `{ result: "User asked to stop — abort the task." }` — abort and inform the user

---

## Lifecycle

| Card | Active | After interaction | Timeout |
|------|--------|-------------------|---------|
| Confirm | Red by default, two buttons | Buttons removed, action shown | Grey 已失效 |
| Form | Blue, input fields | Fields disabled, values shown | Grey 已失效 |
| Progress | Blue, step list + Stop button | Patched manually; Stop → grey 已停止 | Callback registration expires after 24 hours |

---

## Custom Raw Cards

Do not write raw card JSON manually — it is error-prone. Instead, find a working example in `cards-package/CARDS-REFERENCE.md`, then check field details in `cards-package/LARK-CARD-SCHEMA.md`. (Both files are in the same directory as this SKILL.md.)
