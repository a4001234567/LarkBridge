import test from 'node:test';
import assert from 'node:assert/strict';
import { toLarkAppendBlock } from '../src/tools/docs-blocks.js';

test('block batch preparation preserves the original block types and formatting', () => {
  const blocks = [
    toLarkAppendBlock({ type: 'heading2', text: 'Report $x^2$' }),
    toLarkAppendBlock({ type: 'todo', text: 'Review', done: true }),
    toLarkAppendBlock({ type: 'equation', text: 'E=mc^2' }),
    toLarkAppendBlock({ type: 'callout', text: 'Note', callout_bg: 5 }),
    toLarkAppendBlock({ type: 'image', image_path: '/tmp/plot.png' }),
  ];
  assert.deepEqual(blocks.map(block => block.block_type), [4, 17, 2, 19, 27]);
  assert.equal(blocks[0].heading2.elements[1].equation.content, 'x^2\n');
  assert.equal(blocks[1].todo.style.done, true);
  assert.equal(blocks[2].text.elements[0].equation.content, 'E=mc^2\n');
  assert.equal(blocks[3].callout.background_color, 5);
  assert.deepEqual(blocks[4].image, {});
});
