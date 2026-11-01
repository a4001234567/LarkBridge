export type DocAppendBlock = {
  text?: string;
  type?: 'paragraph' | 'heading1' | 'heading2' | 'heading3' | 'heading4' | 'heading5' | 'heading6' |
    'bullet' | 'ordered' | 'code' | 'quote' | 'todo' | 'callout' | 'equation' | 'image';
  bold?: boolean;
  italic?: boolean;
  inline_code?: boolean;
  done?: boolean;
  image_path?: string;
  callout_emoji?: string;
  callout_bg?: number;
};

const BLOCK_TYPES: Record<string, number> = {
  paragraph: 2, heading1: 3, heading2: 4, heading3: 5, heading4: 6, heading5: 7, heading6: 8,
  bullet: 12, ordered: 13, code: 14, quote: 15, todo: 17,
};

/** Build one top-level block; image upload and callout text are finalized after creation. */
export function toLarkAppendBlock(block: DocAppendBlock): any {
  const { text = '', type = 'paragraph', bold, italic, inline_code, done, callout_emoji, callout_bg } = block;
  if (type === 'image') return { block_type: 27, image: {} };
  if (type === 'callout') {
    const callout: any = {};
    if (callout_emoji) callout.emoji_id = callout_emoji;
    if (callout_bg) callout.background_color = callout_bg;
    return { block_type: 19, callout };
  }
  if (type === 'equation') {
    return { block_type: 2, text: {
      elements: [{ equation: { content: text.endsWith('\n') ? text : text + '\n', text_element_style: {} } }],
      style: { align: 1, folded: false },
    } };
  }

  const style: any = {};
  if (bold) style.bold = true;
  if (italic) style.italic = true;
  if (inline_code) style.inline_code = true;
  const supportsInlineEquation = type === 'paragraph' || type.startsWith('heading');
  const elements = supportsInlineEquation
    ? text.split(/(\$[^$]+\$)/g).filter(Boolean).map(part =>
      part.startsWith('$') && part.endsWith('$')
        ? { equation: { content: part.slice(1, -1) + '\n', text_element_style: {} } }
        : { text_run: { content: part, text_element_style: style } })
    : [{ text_run: { content: text, text_element_style: style } }];
  const content: any = { elements };
  if (type === 'paragraph' || type.startsWith('heading')) content.style = {};
  if (type === 'todo') content.style = { done: done ?? false };
  return { block_type: BLOCK_TYPES[type], [type === 'paragraph' ? 'text' : type]: content };
}
