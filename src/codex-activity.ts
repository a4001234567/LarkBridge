import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function marker(stateDir: string, thread: string) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(thread)) throw new Error('Invalid Codex session ID');
  return join(stateDir, 'codex-adapters', `${thread}.active`);
}

export function markCodexTurn(stateDir: string, thread: string, turn: string) {
  const path = marker(stateDir, thread);
  mkdirSync(join(stateDir, 'codex-adapters'), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, turn, { mode: 0o600 });
  renameSync(temporary, path);
}

export function codexTurnActive(stateDir: string, thread: string) {
  try {
    const path = marker(stateDir, thread);
    return Date.now() - statSync(path).mtimeMs < 10 * 60_000;
  } catch { return false; }
}

export function clearCodexTurn(stateDir: string, thread: string, turn?: string) {
  try {
    const path = marker(stateDir, thread);
    if (turn && readFileSync(path, 'utf8') !== turn) return;
    unlinkSync(path);
  } catch { /* Already cleared. */ }
}
