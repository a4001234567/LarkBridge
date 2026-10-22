import { readFileSync } from 'node:fs';
import { config } from '../dist/config.js';
import { Bridge, setBridge } from '../dist/bridge.js';
import { formatEvents } from '../dist/format-events.js';
import { expandForwardedEvents } from '../dist/enrich-events.js';
import { getLarkClient } from '../dist/client.js';

const action = process.argv[2];
if (!['start', 'after-tool', 'stop'].includes(action)) throw new Error('Invalid delivery hook');
const input = JSON.parse(readFileSync(0, 'utf8'));
const thread = input.session_id;
if (typeof thread !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(thread)) throw new Error('Invalid session_id');
const cfg = config();
if (!cfg.postToolInjection) process.exit(0);
const bridge = new Bridge(cfg, { session_id: `hook-${process.pid}`, name: 'Codex delivery hook', harness: 'hook' });
setBridge(bridge);
try {
  await bridge.open();
  if (action !== 'stop') await bridge.call('session_activity', { session_id: thread, active: true });
  if (action === 'start') process.exitCode = 0;
  else {
    const events = await bridge.call('drain_for', { session_id: thread, limit: 100, consumer: 'hook' });
    if (events.length) {
      const shown = await expandForwardedEvents(events,
        messageId => getLarkClient().im.message.get({ path: { message_id: messageId } }));
      const batch = `Lark (reply via Lark tools):\n${formatEvents(shown)}`;
      if (action === 'stop') console.log(JSON.stringify({ decision: 'block', reason: batch }));
      else console.log(JSON.stringify({ hookSpecificOutput: {
        hookEventName: 'PostToolUse', additionalContext: batch,
      } }));
      for (const event of events)
        await bridge.call('ack_for', { session_id: thread, id: event.id, receipt: event.receipt });
    } else if (action === 'stop') {
      await bridge.call('session_activity', { session_id: thread, active: false });
      console.log('{}');
    }
  }
} finally { bridge.close(); }
