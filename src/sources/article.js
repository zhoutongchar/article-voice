import { extractArticle, rangeFor, wordFromPoint } from '../article.js';

// The article adapter owns DOM coordinates. Neither the player nor the voice
// engine needs to know how a site renders its text.
export function createArticleSource() {
  let unit;
  return {
    id: 'article',
    capabilities: { pagination: false, prefetch: false },
    has: id => id === unit?.id,
    current: () => unit,
    async open() {
      unit = { ...extractArticle(), id: 'article' };
      return unit;
    },
    async prepareNext() { return []; },
    async present(id) { if (id !== unit?.id) throw new Error('This reading is no longer available.'); return unit; },
    span(block, start, end) {
      const range = unit?.blocks[block] && rangeFor(unit.blocks[block], start, end);
      return range ? { range, text: range.toString(), rects: [...range.getClientRects()] } : null;
    },
    wordAtPoint(x, y) { return unit ? wordFromPoint(unit, x, y) : null; },
    async cancel() {},
    async dispose() { unit = null; }
  };
}
