import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareMarkdownDescendants } from '../src/tools/docs-markdown.js';

test('Markdown batch payload preserves top-level order and nested tables', () => {
  const source = {
    first_level_block_ids: ['heading', 'table'],
    blocks: [
      { block_id: 'heading', block_type: 3, heading1: { elements: [] } },
      { block_id: 'table', block_type: 31, children: ['cell'],
        table: { cells: ['cell'], property: { row_size: 1, merge_info: [{ row_span: 1 }] } } },
      { block_id: 'cell', block_type: 32, children: ['text'] },
      { block_id: 'text', block_type: 2, text: { elements: [{ text_run: { content: 'value' } }] } },
    ],
  };
  const payload = prepareMarkdownDescendants(source);
  assert.deepEqual(payload.children_id, ['heading', 'table']);
  assert.equal(payload.descendants[1].table.property.row_size, 1);
  assert.equal(payload.descendants[1].table.property.merge_info, undefined);
  assert.equal(payload.descendants[1].table.cells, undefined);
  assert.deepEqual(payload.descendants[2].children, ['text']);
  assert.ok(source.blocks[1].table.property.merge_info, 'converter response is not mutated');
});

test('Markdown batch rejects incomplete or oversized converter results before insertion', () => {
  assert.throws(() => prepareMarkdownDescendants({ blocks: [], first_level_block_ids: [] }), /no usable blocks/);
  assert.throws(() => prepareMarkdownDescendants({ blocks: [{ block_id: 'a' }], first_level_block_ids: ['b'] }), /missing top-level/);
  assert.throws(() => prepareMarkdownDescendants({ blocks: Array.from({ length: 1001 }, (_, i) => ({ block_id: String(i) })), first_level_block_ids: ['0'] }), /at most 1000/);
});
