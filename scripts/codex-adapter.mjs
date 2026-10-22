import { config } from '../dist/config.js';
import { Bridge, setBridge } from '../dist/bridge.js';
import { CodexNotifier } from '../dist/codex-notifier.js';
import { getLarkClient } from '../dist/client.js';
import { expandForwardedEvents } from '../dist/enrich-events.js';

const thread = process.env.LARK_BRIDGE_SESSION_ID ?? process.env.CODEX_THREAD_ID ?? process.env.CODEX_SESSION_ID;
if (!thread) throw new Error('Set LARK_BRIDGE_SESSION_ID or run inside a Codex session');
const bridge = new Bridge(config(), {
  session_id: thread,
  name: process.env.LARK_BRIDGE_SESSION_NAME ?? thread,
  harness: 'codex',
});
setBridge(bridge);
new CodexNotifier(thread, bridge, undefined, events => expandForwardedEvents(
  events,
  messageId => getLarkClient().im.message.get({ path: { message_id: messageId } }),
));
let closing = false;
async function connect() {
  for (let delay = 250; !closing; delay = Math.min(delay * 2, 5000)) {
    try { await bridge.open(); return; }
    catch (error) { process.stderr.write(`[bridge] Codex adapter connection failed: ${error.message}\n`); }
    await new Promise(resolve => setTimeout(resolve, delay));
  }
}
bridge.on('disconnect', () => { if (!closing) void connect(); });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { closing = true; bridge.close(); process.exitCode = 0; });
await connect();
process.stderr.write(`[bridge] Codex adapter registered session ${thread}\n`);
