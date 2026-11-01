# Lark Bridge agent behavior

This project uses one broker-owned Lark long connection. The broker persists events, routes them by originating chat ID, and handles delivery acknowledgments. Agent sessions use the project MCP tools for outbound messages and other Lark actions. Do not start another receiver or call the old `feishu_im_watch` loop.

## Chat subscriptions

- Starting a Codex session or its MCP server does not claim a chat. Project hooks attach this session to the broker when trusted and active; a chat still needs a subscription. If ownership is unclear, inspect `feishu_bridge_sessions` before changing it.
- Use `feishu_bridge_subscribe` for `all`, `all_except`, or `only` chat filters, or `feishu_bridge_assign` to add one chat. A chat held by another live session must be released there before this session can subscribe. Do not assume an outbound reply changes ownership.
- Card actions follow the card's originating chat subscription. Send cards that need registered callbacks through this Bridge's MCP card tools, so the broker has their interaction state before a click arrives. A legacy MCP process can send a card, but its callback registration is invisible to the Bridge that owns the long connection. The broker handles the immediate callback and card response for Bridge-registered cards; treat the delivered action or form values as the user's next input.

## Handling incoming messages

- Treat consecutive messages from a chat as a developing thought. Combine related lines, corrections, and follow-ups into one interpretation; do not acknowledge or answer each line separately. If a new message arrives while working, incorporate it before responding where possible.
- The broker releases a batch after six events or five seconds of quiet. During an active Codex turn, project hooks may inject it after a tool call or before the turn ends; while idle, the adapter queues it for the session. The agent processes the content and does not acknowledge receipts. `feishu_bridge_events` is available when a client needs to retrieve queued events manually.
- When the user is communicating through Lark, send the substantive response through Lark MCP tools unless they explicitly ask to see it in the Codex chat. One coherent reply to a burst is usually enough. Use `feishu_im_send` with a chat ID for a standalone message or a message ID for a threaded reply; text, rich posts, files, and cards remain independent of inbound delivery.
- Delivery is at least once. Before repeating an external action after a repeated event, check whether the action already happened.

For tool details, use the project's MCP prompts: `feishu-watch-loop` for inbound delivery, `feishu-im` for messaging, and the relevant Calendar, Task, Card, People, or Doc prompt for those operations. User OAuth is maintained by the broker; if a tool returns a verification URL, authorize and retry.
