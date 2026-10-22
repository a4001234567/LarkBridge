import { spawn } from 'node:child_process';
import type { Bridge } from './bridge.js';
import { formatEvents, type ClaimedEvent } from './format-events.js';

export type EventNotice = { id: string; chat_id: string; type: string; chat_type?: string | null; peer_id?: string | null };
export type QueueMessage = (thread: string, message: string) => Promise<void>;

export function queueThroughCodex(thread: string, message: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('codex', ['queue', '--thread', thread, '--message', message], {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: process.env,
    });
    let stderr = '';
    const timeout = setTimeout(() => child.kill('SIGTERM'), 15_000);
    child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-1000); });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('close', code => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(`codex queue exited ${code}: ${stderr.trim()}`));
    });
  });
}

export class CodexNotifier {
  private active = false;
  private seen = new Set<string>();
  private flushAfterCurrent = false;
  constructor(
    readonly thread: string,
    readonly bridge: Pick<Bridge, 'on' | 'call'>,
    readonly queue: QueueMessage = queueThroughCodex,
    readonly enrich: (events: ClaimedEvent[]) => Promise<ClaimedEvent[]> = async events => events,
  ) {
    bridge.on('notice', notice => this.receive(notice.events ?? []));
  }
  receive(events: EventNotice[]) {
    const current = new Set(events.map(event => event.id));
    const fresh = events.some(event => !this.seen.has(event.id));
    this.seen = current;
    if (!current.size) this.seen.clear();
    else if (fresh) void this.flush();
  }
  private async flush() {
    if (this.active) { this.flushAfterCurrent = true; return; }
    this.active = true;
    let events: ClaimedEvent[] = [];
    try {
      events = await this.bridge.call('drain_for', { session_id: this.thread, limit: 100, consumer: 'adapter' });
      if (!events.length) { this.seen.clear(); return; }
      const shown = await this.enrich(events);
      await this.queue(this.thread, `Lark (reply via Lark tools):\n${formatEvents(shown)}`);
      for (const event of events)
        await this.bridge.call('ack_for', { session_id: this.thread, id: event.id, receipt: event.receipt });
    } catch (error) {
      process.stderr.write(`[bridge] Codex delivery failed: ${error instanceof Error ? error.message : error}\n`);
    } finally {
      for (const event of events) this.seen.delete(event.id);
      this.active = false;
      if (this.flushAfterCurrent) {
        this.flushAfterCurrent = false;
        void this.flush();
      }
    }
  }
}
