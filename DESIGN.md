# Lark Bridge design

Lark Bridge connects one Lark app to existing agent sessions. It does not create
agent sessions or make the broker responsible for the agent's replies.

## Process boundaries

| Component | Responsibility |
| --- | --- |
| Broker | Own the app's one long-lived Lark event connection, token refresh, SQLite event queue, chat subscriptions, session reminders, and immediate card callback responses. |
| Session adapter | Register a stable agent-session ID, receive broker notices, and deliver events to that session. The Codex adapter uses `codex queue`. |
| Stdio MCP server | Give an agent independent message, card, people, calendar, task, document, wiki, and token-proxy tools. It asks the broker for tokens, then calls Lark directly. |

The broker is detached from the session that starts it. A startup `flock` prevents
duplicate brokers. A second, app-scoped `flock` is held for the full WebSocket
lifetime, preventing another local process that uses the same lock from opening
a competing event connection. Multiple MCP servers and adapters can share this
one broker through a private Unix socket.

## Listening and routing

An agent session "listens" through a persisted filter on **chat IDs**, not
another Lark connection. The filter may match every chat, every chat except a
listed set, or only a listed set. Filters of live sessions must be disjoint; a
live owner must release a chat before another live session can take it. Offline
sessions do not block a new claim. Messages and card actions both use the chat
ID in their Lark payload as the routing key; a card's registration never chooses
the destination. Changing ownership invalidates outstanding delivery receipts.
Events for an unassigned or offline session remain buffered.

Codex does not reliably provide its thread ID to a newly started stdio MCP
process. The Codex hook or adapter therefore binds the actual thread ID
explicitly. The outbound MCP server can be loaded separately. A status call from
a new MCP process alone does not subscribe that Codex thread to a chat.

## Inbound delivery

1. The broker receives a configured Lark event type and keeps its original
   envelope. It requires an originating chat ID and deduplicates by event ID.
2. SQLite WAL persists the event, route, and delivery state before agent work.
3. The broker releases a session's batch when it contains at least six events
   or the latest event arrived at least five seconds ago. A drain request does
   not start or extend this clock. An empty queue returns immediately.
4. During an active Codex turn, project hooks drain a ready batch after a tool
   call or before the turn stops. While idle, the adapter drains and submits
   the batch with `codex queue --thread`. A progress-card update can optionally
   drain for an explicit session ID. Claims prevent two consumers from taking
   the same event, and receipts stay inside the bridge.

The idle adapter does not claim events while hooks mark the session active.
`PostToolUse` supplies its batch as model-visible hook context for the next
model step. `Stop` continues the turn with a batch if one is ready; otherwise
it marks the session idle. The adapter remains the wake-up path for idle turns.

Claims have a lease and delivery is **at least once**. A failed queue operation
leaves the event eligible for retry. An agent should account for possible
redelivery before repeating an external side effect. Acknowledged event IDs
remain in SQLite for deduplication; automatic compaction is not implemented.

The compact view groups by chat and sender, displays the full date once per
sender/day, resolves text mentions, and includes resource keys and message IDs
when needed to fetch attachments. `feishu_bridge_events(raw=true)` exposes the
original payload when the compact view is insufficient.

The original watch-loop schedules are persisted by the broker and produce
session-targeted reminder events. They have no Lark chat ID, so chat filters do
not decide their destination. A reminder for an offline session remains queued
until that session reconnects.

## Outbound tools and cards

Outbound actions stay independent of event delivery. An agent can call the MCP
send/reply, rich text, file, or card tools at any point in a turn. The broker
shares tenant and user access tokens but is not a proxy for the Lark message API.
Tenant-token bot messaging and user OAuth have separate lifecycles.

Interactive-card tools register serializable callback intent **before** sending
the card. They place a correlation ID in callback values and bind the returned
message ID afterward. A callback arriving before binding can still match the
correlation ID; callbacks without it can match the bound message ID. The broker
persists each click as a chat-routed event and immediately returns the predefined
toast or inline card update to Lark. The assigned agent later receives the
action and any form values. This avoids waiting for an agent turn inside Lark's
callback response path. Custom executable handlers belong in a tool process,
not in the broker's persisted interaction record. The local API token proxy is
an exception: its Stop card revokes a hashed token in broker state immediately,
while the proxy process still makes the outbound HTTP requests.

## Boundaries

The implementation targets Linux (`flock`) and Node.js 22.16+ (`node:sqlite`).
The Unix socket and state directory are private to the local OS account; they
are not an isolation boundary between untrusted processes running as that same
account. Native Claude Channels delivery, event retention/compaction, and
automatic REST patching of expired asynchronous cards are not implemented.

The protocol and card behavior draw on the
[official Lark OpenAPI MCP](https://github.com/larksuite/lark-openapi-mcp),
[Lark CLI](https://github.com/larksuite/cli), and
[card callback documentation](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/handle-card-callbacks).
