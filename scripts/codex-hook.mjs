import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, unlinkSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../dist/config.js';
import { clearCodexTurn } from '../dist/codex-activity.js';

const action = process.argv[2];
if (action !== 'start' && action !== 'end') throw new Error('Expected start or end');
const input = JSON.parse(readFileSync(0, 'utf8'));
const thread = input.session_id;
if (typeof thread !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(thread)) throw new Error('Invalid session_id');
const directory = join(config().stateDir, 'codex-adapters');
mkdirSync(directory, { recursive: true, mode: 0o700 });
const pidFile = join(directory, `${thread}.pid`);

function running(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('codex-adapter.mjs');
  } catch { return false; }
}

let previous;
try { previous = Number(readFileSync(pidFile, 'utf8')); } catch {}
if (action === 'end') {
  clearCodexTurn(config().stateDir, thread);
  if (running(previous)) process.kill(previous, 'SIGTERM');
  try { unlinkSync(pidFile); } catch {}
} else if (!running(previous)) {
  const log = openSync(join(directory, 'adapter.log'), 'a', 0o600);
  const child = spawn(process.execPath, [new URL('./codex-adapter.mjs', import.meta.url).pathname], {
    detached: true,
    stdio: ['ignore', log, log],
    env: { ...process.env, LARK_BRIDGE_SESSION_ID: thread },
  });
  child.unref();
  closeSync(log);
  writeFileSync(pidFile, `${child.pid}\n`, { mode: 0o600 });
}
if (action === 'start') console.log(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'SessionStart',
    additionalContext: `This Codex thread's Lark Bridge session ID is ${thread}. To receive a Lark chat, use feishu_bridge_subscribe or feishu_bridge_assign with this session ID. The broker rejects chats already held by another live session.`,
  },
}));
