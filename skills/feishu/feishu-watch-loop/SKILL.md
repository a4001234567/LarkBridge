---
name: feishu-watch-loop
description: Handle Lark messages, card actions, and reminders delivered to an agent session by Lark Bridge. Use when working from an inbound Lark event or configuring which chats a session receives.
---

# Lark Bridge message loop

This replaces the original `feishu_im_watch` loop. Do not call or recreate a blocking watch receiver. The broker holds the one Lark long connection, persists incoming events, and routes each chat to one live subscribed session. The agent processes delivered content; delivery and acknowledgment belong to the bridge.

## Subscribe and receive

- Use `feishu_bridge_sessions` to inspect live sessions and chat ownership. `feishu_bridge_subscribe` chooses `all`, `all_except`, or `only` chat IDs for a live session; `feishu_bridge_assign` adds one chat to an only-list. A chat held by another live session must be released by that owner before reassignment.
- A session's outbound MCP process and its inbound subscription are separate. Starting the MCP server or sending a message does not subscribe the current agent session to a chat.
- The broker releases a batch after six queued events or five seconds without a new event. The Codex adapter queues ready messages while idle; project hooks can inject a ready batch after a tool call or at turn end. Other clients can call `feishu_bridge_events` to retrieve a batch. The bridge acknowledges delivered events; the agent does not handle receipts.
- Delivery is at least once. If an event reappears, check whether its requested external action was already performed before repeating it.

## Interpret and respond

- The compact view groups by chat and sender. A p2p message may show only `user: ou_xxx`; group messages show `chat: oc_xxx`. Consecutive content from one sender can form one request, so answer the combined intent rather than replying once per line.
- Text mentions include the mentioned person's name and ID. Images, files, audio, and video carry the message ID and resource key needed by `feishu_im_fetch_resource`. Forwarded history is expanded when possible. Use `feishu_im_get_message` for more detail on a delivered message. When manually retrieving a still-queued batch, `feishu_bridge_events(raw=true)` returns the original payload.
- Send a Lark reply with `feishu_im_send`: a chat ID (`oc_xxx`) for a standalone chat message or a message ID (`om_xxx`) for a threaded reply. Use rich posts or cards when their formatting serves the response. Outbound tools remain available at any point in the turn.
- Registered card clicks and form submissions follow the card's originating chat assignment and arrive as events with the action and form values. The broker handles the immediate Lark callback and inline update; the agent handles any subsequent work. Registered-card tools require the chat ID as `receive_id`.
- `feishu_schedule_*` reminders target a session directly and do not need a chat subscription.

If user OAuth is missing for Calendar, Task, People, or document actions, the tool returns a verification URL. Authorization is handled by the broker; after the user authorizes, retry the operation.
