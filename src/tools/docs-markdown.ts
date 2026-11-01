/** Prepare the output of Lark's Markdown-to-block converter for batch insertion. */
export function prepareMarkdownDescendants(data: any) {
  const blocks: any[] = data?.blocks;
  const firstLevelIds: string[] = data?.first_level_block_ids;
  if (!Array.isArray(blocks) || !Array.isArray(firstLevelIds) || blocks.length === 0 || firstLevelIds.length === 0)
    throw new Error('Lark Markdown conversion returned no usable blocks');
  if (blocks.length > 1000)
    throw new Error(`Markdown converted to ${blocks.length} blocks; one batch supports at most 1000`);

  const ids = new Set(blocks.map(block => block.block_id));
  if (firstLevelIds.some(id => !ids.has(id)))
    throw new Error('Lark Markdown conversion returned a missing top-level block');

  const descendants = blocks.map(block => {
    if (!block.table) return block;
    const { cells: _cells, property, ...table } = block.table;
    const { merge_info: _mergeInfo, ...cleanProperty } = property ?? {};
    return { ...block, table: { ...table, property: cleanProperty } };
  });
  return { children_id: firstLevelIds, descendants, index: -1 };
}
