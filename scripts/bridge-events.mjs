import { config } from '../dist/config.js';
import { Bridge, setBridge } from '../dist/bridge.js';
import { formatEvents } from '../dist/format-events.js';
import { expandForwardedEvents } from '../dist/enrich-events.js';
import { getLarkClient } from '../dist/client.js';
import { writeSync } from 'node:fs';

const [command, flag, target, option] = process.argv.slice(2);
if (!['events', 'assign', 'sessions'].includes(command)) throw new Error('Usage: bridge-events.mjs events|assign|sessions --session SESSION [--raw|CHAT_ID]');
if (flag !== '--session' || !target) throw new Error('Pass --session with the Codex thread ID');
const bridge = new Bridge(config(), {
  session_id: `cli-${process.pid}`,
  name: 'Lark Bridge CLI',
  harness: 'cli',
});
setBridge(bridge);
try {
  await bridge.open();
  let result;
  if (command === 'events') {
    if (option && option !== '--raw') throw new Error('Expected --raw');
    result = await bridge.call('fetch_for', { session_id: target, limit: 20 });
    const shown = option === '--raw' ? result : await expandForwardedEvents(result,
      messageId => getLarkClient().im.message.get({ path: { message_id: messageId } }));
    const output = option === '--raw'
      ? JSON.stringify(result.map(({ receipt, ...event }) => event), null, 2)
      : formatEvents(shown);
    writeSync(1, output + '\n');
    for (const event of result)
      await bridge.call('ack_for', { session_id: target, id: event.id, receipt: event.receipt });
  }
  if (command === 'assign') {
    if (!option?.startsWith('oc_')) throw new Error('Pass chat ID after --session');
    result = await bridge.call('route', { session_id: target, chat_id: option });
  }
  if (command === 'sessions') result = await bridge.call('sessions');
  if (command !== 'events') writeSync(1, JSON.stringify(result, null, 2) + '\n');
} finally { bridge.close(); }
