# Lark Session Bridge

A shared inbound broker and a lightweight stdio MCP server for existing agent sessions. Message and card tools remain independent of event delivery; authentication, the Lark WebSocket, interaction registration, and inbound routing live in the broker.

## Responsibilities

- **Broker:** one process per configured integration, OAuth and tenant tokens, WebSocket events/callbacks, SQLite event buffering, deduplication, chat assignments, delivery receipts, and immediate card responses.
- **Session MCP server:** registers a stable session identity, receives event notices, exposes retrieval/acknowledgement tools, and makes outbound Lark API calls directly. It obtains access tokens over the local socket; the broker never proxies message API calls.
- **Routing:** one live session owns each subscribed chat. Filters can include all chats, all except listed chats, or only listed chats. Card registrations provide callback response behavior, never a destination.

## Run

Requires Linux with `flock`, Node.js 22.16 or newer (built-in SQLite), and npm.

```bash
npm ci
npm run build
```

Create a private configuration file outside the repository:

```json
{
  "appId": "cli_your_app",
  "appSecret": "your_app_secret",
  "domain": "https://open.feishu.cn",
  "continuous": false,
  "graceMs": 60000
}
```

Restrict this file to your OS user. Set `LARK_BRIDGE_CONFIG` to its absolute path. Alternatively provide `LARK_APP_ID` and `LARK_APP_SECRET` through the process environment. For international Lark, set `domain` to `https://open.larksuite.com`.

Example generic MCP configuration (give every participating agent session its own stable ID):

```json
{
  "mcpServers": {
    "lark": {
      "command": "node",
      "args": ["/absolute/path/to/Lark_Bridge/dist/index.js"],
      "env": {
        "LARK_BRIDGE_CONFIG": "/absolute/path/to/private/lark-bridge.json",
        "LARK_BRIDGE_SESSION_ID": "my-project-session-1",
        "LARK_BRIDGE_SESSION_NAME": "My project",
        "LARK_BRIDGE_HARNESS": "mcp"
      }
    }
  }
}
```

The first session starts a detached broker. An OS-held `flock` prevents simultaneous startup from creating duplicate brokers. A second app-scoped `flock`, shared with the legacy MCP server, is held for the full Lark WebSocket lifetime. Another local process using the same app ID cannot open a competing WebSocket; the broker fails startup if that lock is held, and the legacy server falls back to polling. The lock releases automatically after a process crash. Closing the launching session leaves the broker running for other sessions. The broker shuts down after the last connection and the grace period, checked every five seconds. Set `continuous: true` to keep collecting with no connected sessions.

You can also run the broker explicitly with `npm run broker`, with the same configuration. Already running brokers reject a second startup through the lock. Session adapters reconnect automatically if the broker restarts. A second _live_ connection using the same session ID is rejected.

By default, state is under `~/.local/state/lark-bridge/<app-id-hash>/`. The directory is mode 0700; the Unix socket and encrypted token file are mode 0600. `stateDir` or `LARK_BRIDGE_STATE_DIR` can override the directory; all participants must use the same path. Access is scoped to the OS account, not separate untrusted users sharing that account.

## Existing authorization

The broker can import the original server's keyed, AES-256-GCM encrypted `tokens.json`, or its older plaintext format. Set `tokenImport` in the private config (or `LARK_BRIDGE_IMPORT_TOKENS`) to that file. Import happens only if the broker has no token file. The source is read without modification; the broker stores its own encrypted copy using the same app secret derivation as the original.

Before a live cutover, stop the old server's OAuth refresher for this app/user authorization. Two independently running refreshers can rotate the same refresh token. The shared app-scoped lock now prevents the updated legacy server and bridge from opening two local event connections, but older installed copies that do not use this lock must still be stopped. Importing is a migration, not a mechanism for sharing token state with the old process.

For fresh authorization, call `feishu_auth_init` with a module name (default `all`) or an explicit scope string. It returns a verification URL immediately; the broker polls in the background. Pass `receive_id` to also send an authorization card to a Lark user or chat. `feishu_auth_status` reports completion and module scope status. Messaging as the app uses a tenant token and does not require user OAuth. No credentials are returned in agent-visible status tools.

The migrated people, calendar, task, and document tools use the broker's shared user token. When authorization or a recorded module scope is missing, a tool returns the verification URL from the broker's device flow; authorize and retry the tool. Tenant-token wiki operations remain available without user OAuth where Lark permits them.

## Session operation

1. Call `feishu_bridge_sessions` to see registered sessions and filters.
2. Call `feishu_bridge_subscribe` with a live session ID and `mode: "all"`, `"all_except"`, or `"only"`. Pass chat IDs for the latter two. `feishu_bridge_assign` adds one chat to an existing only-list.
3. A brief MCP logging notification announces available events.
4. The Codex adapter delivers compact, `feishu_im_watch`-style event content directly to the assigned session and handles acknowledgment after Codex accepts it. The agent only handles the message. Other clients can call `feishu_bridge_events` to retrieve events; that tool handles acknowledgment itself and supports `raw=true` for full Lark payloads.

Internally, the broker uses 60-second delivery leases. If Codex delivery fails, an event becomes eligible for redelivery after the lease expires. This is **at-least-once delivery**: agents should avoid repeating an outbound side effect if the same message is delivered again. Acknowledged event IDs remain stored for deduplication; automatic retention/compaction is not implemented yet.

The default event view follows the old `feishu_im_watch` layout:

```text
user: ou_...
  2026-10-17 13:49  "hi？"
```

Group events show the originating `chat: oc_...` once, then one `user: ou_...` block per sender. Events within each sender block are sorted by time. The first event of each day shows the full date; later events that day show only hour and minute. Card actions and other event types use the same grouping. Message IDs appear for images and files where they are needed to fetch attachments. `feishu_bridge_events(raw=true)` returns the original batch when manual inspection is needed.

Text @mentions are rendered with the mentioned name and open ID. Forwarded chat-history (`merge_forward`) messages are expanded from Lark's message lookup; consecutive entries from one sender share a single user label while their original order is preserved. If lookup fails, the compact event still provides its message ID. `feishu_im_get_message` retrieves the full bundle. Audio, files, images and video include their resource keys and message ID for `feishu_im_fetch_resource`; audio transcription is not performed by the bridge. Incoming card messages preserve the parsed content JSON, as in Yet Another Lark MCP's `feishu_im_watch`, while card clicks show their action and form values. `feishu_im_read` accepts a chat ID, a known p2p user's open ID, or a thread message ID, and returns a `page_token` for further history pages.

`feishu_bridge_pause` pauses this session's retrieval and notices while keeping collection active; it does not release the session's chat ownership. Unsubscribed chats remain buffered until a live session subscribes. Socket heartbeats expire after 45 seconds; saved filters can resume on reconnection unless a new live owner has claimed an overlapping chat.

Subscriptions from different live sessions cannot overlap. A session with `all` therefore excludes every other live subscriber; use `all_except` to reserve chats for an `only` subscriber. To transfer a chat between live sessions, first remove it from the current session's filter, then add it to the destination. An offline session does not hold a chat against a live claimant. If its saved broad filter conflicts when it reconnects, the broker drops that filter and the session must subscribe again.

The WebSocket adapter accepts configured event types generically and keeps their original payloads. It supports current event envelopes and the original server's card-frame compatibility behavior. Incoming payloads must contain a chat ID in `event.context.open_chat_id`, `event.message.chat_id`, `event.chat_id`, or `event.open_chat_id`; malformed payloads fail ingestion rather than being routed by a different identity.

## Tools retained and adapted

- Original `feishu_im_send`: plain text, rich posts, interactive cards, image/file uploads, and message replies.
- Original read, resource-download, and message-search tools from `tools/im.ts`; search obtains a user token from the broker.
- People search, calendar, task, document, and wiki tools from Yet Another Lark MCP. User-authenticated SDK calls and direct HTTPS calls obtain tokens through the broker.
- `feishu_auth_whoami` and `feishu_auth_issue_token`. The latter starts a local HTTP proxy, sends a monitoring card, and registers its Stop button with the broker for immediate revocation.
- `feishu_schedule_create`, `feishu_schedule_list`, and `feishu_schedule_delete`. Reminders persist in the broker and are delivered to a specific agent session without a chat subscription; pass `session_id` when the tool's own MCP process has a separate identity.
- `feishu_im_send_confirm` and `feishu_im_send_form`: original card builders, default asynchronous delivery, optional blocking result.
- `feishu_im_send_progress` / `feishu_im_patch_progress`: progress cards and immediate Stop responses.
- `feishu_im_send_card`: custom cards with serializable immediate responses keyed by `action.value.action`.
- `feishu_im_update_card`: direct card updates through Lark.

Registered-card tools take a chat ID as `receive_id`, so registration exists before the send. A correlation ID is embedded in callback values, then bound to the returned message ID. A click arriving before binding still finds its registration. The original general-purpose send tool continues accepting its other recipient types.

Card callbacks are persisted and acknowledged with predefined toasts/inline card updates without waiting for an agent. Blocking waits retrieve only their card's events and still obey the current chat assignment: they do not pull a callback out of another session's inbox. Expiry is maintained by the broker even when no agent is watching. Asynchronous expired cards return an expiry toast on click; automatic REST patching of their appearance is not implemented. The token-proxy Stop action is a dedicated broker-side exception that revokes the proxy token before the callback response is sent.

## Scope and validation

This implements the broker, shared auth, socket session adapter, messaging and card tools, people/calendar/task/document/wiki tools, session reminders, a local token proxy, MCP event retrieval/acknowledgement, and a Codex `codex queue` wake-up adapter. The original `feishu_im_watch` is replaced by broker subscriptions and event delivery; it is not exposed as a second blocking receiver. The bridge does not create agent sessions. Native Claude Channels integration remains future work; MCP logging notifications alone do not guarantee that a harness starts an agent turn.

```bash
npm test
npm run check
```

Tests use temporary state, fake credentials, simulated Lark events, real Unix sockets, two actual stdio MCP processes, and the pinned SDK's frame handler. They do not connect to Lark or send messages. `LARK_BRIDGE_OFFLINE=1` disables WebSocket and authentication for local development. There is deliberately no production event-injection RPC.

The pinned Lark SDK uses two compatibility boundaries covered by tests: card frame handling and its token manager. Axios is overridden to a patched compatible version while preserving the existing SDK behavior. Live receive, threaded reply, and confirm/form callback flows were exercised manually in October 2026. Live OAuth and WebSocket reconnection still need integration testing.

See [DESIGN.md](DESIGN.md) for principles and official upstream references. Reused source is covered by [LICENSE](LICENSE).

## Live receive smoke test

With a private `LARK_BRIDGE_CONFIG` configured, run:

```bash
LARK_BRIDGE_TEST_MARKER=bridge-test node scripts/receive-smoke.mjs
```

The script validates app authentication, waits for the WebSocket to connect, and waits up to ten minutes for an incoming text message containing the marker. Send that marker to the bot (mention the bot in a group). It then assigns that test chat to its temporary session, fetches the event through the broker socket, and verifies acknowledgement in SQLite. Use a dedicated test state directory because the test changes the matching chat assignment. Other listeners for the same app may receive some messages instead. The script sends no messages and does not import user OAuth credentials.

## Codex delivery adapter

`node scripts/codex-adapter.mjs` registers the current Codex thread as a broker session using `LARK_BRIDGE_SESSION_ID`, `CODEX_THREAD_ID`, or `CODEX_SESSION_ID`. Give it the same private Lark config as the broker. Subscribe a chat with `node scripts/bridge-events.mjs assign --session <THREAD_ID> <CHAT_ID>`. The adapter batches new events until five seconds pass without another event, or flushes immediately when six are pending. Repeated broker notices for the same events do not reset the timer. It queues one compact batch to that thread with `codex queue --thread <THREAD_ID>` and acknowledges it after Codex accepts the queue request. The agent does not handle delivery receipts.

The adapter submits the batch even if Codex is in an active turn. Codex processes
queued messages after that turn; the queue command does not steer the current
model step. The five-second quiet window is the only bridge-side delay.

Codex loads the outbound MCP tools from this repository's `.codex/config.toml`.

The MCP process alone does not subscribe the Codex thread to a chat: Codex may
not pass its thread ID to that process. Start an adapter bound to the actual
thread ID, then set a chat filter for it. A new session receives no chat until
it subscribes, and overlapping filters are rejected while both sessions live.

`node scripts/bridge-events.mjs events --session <THREAD_ID>` retrieves a compact batch and handles acknowledgment. Pass `--raw` for the original full batch. These commands load `.codex/local-config.json` unless `LARK_BRIDGE_CONFIG` is set. A session MCP server with `LARK_BRIDGE_HARNESS=codex` can also deliver messages directly; it must have a stable `LARK_BRIDGE_SESSION_ID` or a Codex thread ID in its environment. Run one registered adapter per thread at a time.

The CLI can also set filters for a live thread:

```bash
node scripts/bridge-events.mjs subscribe --session <THREAD_ID> all
node scripts/bridge-events.mjs subscribe --session <THREAD_ID> all-except oc_reserved
node scripts/bridge-events.mjs subscribe --session <THREAD_ID> only oc_one oc_two
```

This repository includes project-scoped `.codex/config.toml` and `.codex/hooks.json`. They load the MCP server and run `SessionStart` (`startup`, `resume`, `clear`, `fork`) and `SessionEnd` hooks only for trusted Codex sessions opened in this repository. Put a private Lark config at `.codex/local-config.json` (or symlink that ignored path to a config elsewhere); `LARK_BRIDGE_CONFIG` still overrides it. The hook reads Codex's `session_id` from its JSON stdin, starts the adapter detached, and stops only its recorded adapter at session end. Codex requires local hooks to be reviewed and trusted through `/hooks` before they run; newly changed hook definitions need review again. Existing sessions may need to restart to load the project configuration.
