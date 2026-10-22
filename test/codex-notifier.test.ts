import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { CodexNotifier } from '../src/codex-notifier.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('mediator queues event content and acknowledges only after delivery succeeds', async () => {
  const sent: string[] = [], acknowledged: string[] = [];
  const event = {
    id: 'event-1', chat_id: 'oc_private', chat_type: 'p2p', peer_id: 'ou_user',
    type: 'im.message.receive_v1', received_at: Date.parse('2026-10-17T06:00:00Z'), receipt: 'private-lease',
    payload: { event: { sender: { sender_id: { open_id: 'ou_user' } }, message: {
      chat_id: 'oc_private', chat_type: 'p2p', message_type: 'text', content: '{"text":"hello"}',
    } } },
  };
  class FakeBridge extends EventEmitter {
    async call(method: string, args: any): Promise<any> {
      assert.equal(args.session_id, 'thread-id');
      if (method === 'drain_for') return acknowledged.length ? [] : [event];
      if (method === 'ack_for') { acknowledged.push(args.id); return {}; }
      throw new Error(`Unexpected ${method}`);
    }
  }
  const bridge = new FakeBridge();
  let failures = 1;
  new CodexNotifier('thread-id', bridge, async (thread, message) => {
    assert.equal(thread, 'thread-id');
    if (failures-- > 0) throw new Error('not connected');
    sent.push(message);
  });
  bridge.emit('notice', { events: [event] });
  await tick();
  assert.deepEqual(acknowledged, []);
  bridge.emit('notice', { events: [event] });
  await tick();
  assert.deepEqual(acknowledged, ['event-1']);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /^Lark \(reply via Lark tools\):\nuser: ou_user\n  2026-10-17 14:00  "hello"$/);
  assert.doesNotMatch(sent[0], /receipt|oc_private|event-1|feishu_bridge_events|feishu_bridge_ack/);
});

test('six pending messages flush together without waiting for the quiet timer', async () => {
  const sent: string[] = [], acknowledged: string[] = [];
  const events = Array.from({ length: 6 }, (_, index) => ({
    id: `event-${index}`, chat_id: 'oc_group', chat_type: 'group', type: 'im.message.receive_v1',
    received_at: Date.parse('2026-10-17T06:00:00Z') + index * 1000, receipt: `lease-${index}`,
    payload: { event: {
      sender: { sender_id: { open_id: 'ou_user' } },
      message: { chat_id: 'oc_group', chat_type: 'group', message_type: 'text', content: JSON.stringify({ text: `message ${index}` }) },
    } },
  }));
  class FakeBridge extends EventEmitter {
    async call(method: string, args: any): Promise<any> {
      if (method === 'drain_for') return events.filter(event => !acknowledged.includes(event.id));
      if (method === 'ack_for') { acknowledged.push(args.id); return {}; }
      throw new Error(`Unexpected ${method}`);
    }
  }
  const bridge = new FakeBridge();
  new CodexNotifier('thread-id', bridge, async (_thread, message) => { sent.push(message); });
  bridge.emit('notice', { events });
  await tick();
  assert.equal(sent.length, 1);
  assert.equal(acknowledged.length, 6);
  assert.equal(sent[0].match(/user: ou_user/g)?.length, 1);
  assert.match(sent[0], /"message 0"/);
  assert.match(sent[0], /"message 5"/);
});

test('repeated notices do not duplicate a batch while broker drain is in flight', async () => {
  const event = { id: 'same', chat_id: 'oc_group', type: 'im.message.receive_v1',
    received_at: Date.now(), receipt: 'lease', payload: { event: {
      sender: { sender_id: { open_id: 'ou_user' } },
      message: { chat_id: 'oc_group', message_type: 'text', content: '{"text":"one"}' },
    } } };
  let delivered = false, sends = 0;
  class FakeBridge extends EventEmitter {
    async call(method: string): Promise<any> {
      if (method === 'drain_for') { await wait(30); return delivered ? [] : [event]; }
      if (method === 'ack_for') { delivered = true; return {}; }
      throw new Error(`Unexpected ${method}`);
    }
  }
  const bridge = new FakeBridge();
  new CodexNotifier('thread-id', bridge, async () => { sends++; });
  bridge.emit('notice', { events: [event] });
  await wait(10);
  bridge.emit('notice', { events: [event] });
  await wait(40);
  assert.equal(delivered, true);
  assert.equal(sends, 1);
});
