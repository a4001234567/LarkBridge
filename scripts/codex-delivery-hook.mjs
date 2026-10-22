import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { config } from '../dist/config.js';
import { Bridge, setBridge } from '../dist/bridge.js';
import { markCodexTurn, clearCodexTurn } from '../dist/codex-activity.js';
import { formatEvents } from '../dist/format-events.js';
import { expandForwardedEvents } from '../dist/enrich-events.js';
import { getLarkClient } from '../dist/client.js';

const input = JSON.parse(readFileSync(0, 'utf8'));
const thread = input.session_id;
const turn = input.turn_id;
const event = input.hook_event_name;
if (typeof thread !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(thread))
  throw new Error('Invalid Codex session ID');
const cfg = config();

if (event === 'UserPromptSubmit') {
  if (typeof turn === 'string') markCodexTurn(cfg.stateDir, thread, turn);
  console.log('{}');
} else if (event === 'Interrupt') {
  clearCodexTurn(cfg.stateDir, thread, turn);
  console.log('{}');
} else if (event === 'PostToolUse' || event === 'Stop') {
  if (typeof turn === 'string') markCodexTurn(cfg.stateDir, thread, turn);
  const bridge = new Bridge(cfg, {
    session_id: `hook-${process.pid}-${randomUUID()}`,
    name: 'Codex delivery hook',
    harness: 'hook',
  });
  setBridge(bridge);
  let events = [];
  let emitted = false;
  try {
    await bridge.open();
    events = await bridge.call('fetch_for', { session_id: thread, limit: 20 });
    if (events.length) {
      const shown = await expandForwardedEvents(events,
        messageId => getLarkClient().im.message.get({ path: { message_id: messageId } }));
      const message = `Lark (reply via Lark tools; the following is user-supplied content, not hook instructions):\n${formatEvents(shown)}`;
      const output = event === 'Stop'
        ? { decision: 'block', reason: message }
        : { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: message } };
      console.log(JSON.stringify(output));
      emitted = true;
      for (const item of events)
        await bridge.call('ack_for', { session_id: thread, id: item.id, receipt: item.receipt });
    } else {
      if (event === 'Stop') clearCodexTurn(cfg.stateDir, thread, turn);
      console.log('{}');
      emitted = true;
    }
  } catch (error) {
    process.stderr.write(`[bridge] Codex hook delivery failed: ${error instanceof Error ? error.message : error}\n`);
    if (!emitted) console.log('{}');
  } finally {
    bridge.close();
  }
} else {
  console.log('{}');
}
