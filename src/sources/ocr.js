const validBox = box => box && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(box[key]))
  && box.x >= 0 && box.y >= 0 && box.width > 0 && box.height > 0 && box.x + box.width <= 1.001 && box.y + box.height <= 1.001;

// Vision is the boundary owner for UTF-16 word offsets and normalized, top-left
// image coordinates. Parse it once; all hit testing and marks use these facts.
export function ocrBlocks(value) {
  if (!value || !Array.isArray(value.lines) || !value.lines.length || value.lines.length > 2000)
    throw new Error('No readable text was found on this page.');
  const lines = value.lines.map(line => {
    if (typeof line.text !== 'string' || !line.text.length || !validBox(line.box) || !Array.isArray(line.words))
      throw new Error('The text recognizer returned invalid page coordinates.');
    let previous = 0;
    const words = line.words.map(word => {
      if (!Number.isInteger(word.start) || !Number.isInteger(word.end) || word.start < previous || word.end <= word.start
        || word.end > line.text.length || !validBox(word.box)) throw new Error('The text recognizer returned invalid word coordinates.');
      previous = word.end;
      return { start: word.start, end: word.end, box: { ...word.box } };
    });
    return { text: line.text, box: { ...line.box }, words };
  });
  const xs = [...new Set(lines.map(line => line.box.x))].sort((a, b) => a - b);
  let split, gap = 0;
  for (let i = 1; i < xs.length; i++) if (xs[i] - xs[i - 1] > gap) { gap = xs[i] - xs[i - 1]; split = (xs[i] + xs[i - 1]) / 2; }
  const left = lines.filter(line => line.box.x < split), right = lines.filter(line => line.box.x >= split);
  const columns = gap > .18 && left.length >= 2 && right.length >= 2
    && Math.max(...left.map(line => line.box.x + line.box.width)) <= Math.min(...right.map(line => line.box.x)) + .025
    ? [left, right] : [lines];
  const blocks = [];
  for (const column of columns) {
    column.sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
    const heights = column.map(line => line.box.height).sort((a, b) => a - b), height = heights[Math.floor(heights.length / 2)];
    const edge = Math.min(...column.map(line => line.box.x));
    let block, previous;
    for (const line of column) {
      if (!block || line.box.y - (previous.box.y + previous.box.height) > height * .65
        || (line.box.x > edge + height * .5 && /[.!?。！？”"]$/.test(previous.text))) {
        block = { text: '', words: [] }; blocks.push(block);
      }
      const offset = block.text.length + (block.text ? 1 : 0);
      block.text += (block.text ? ' ' : '') + line.text;
      block.words.push(...line.words.map(word => ({ ...word, start: word.start + offset, end: word.end + offset })));
      previous = line;
    }
  }
  return blocks;
}

const project = (box, rectangle) => ({
  left: rectangle.left + box.x * rectangle.width, top: rectangle.top + box.y * rectangle.height,
  width: box.width * rectangle.width, height: box.height * rectangle.height,
  right: rectangle.left + (box.x + box.width) * rectangle.width,
  bottom: rectangle.top + (box.y + box.height) * rectangle.height
});

export function imageSpan(unit, rectangle, block, start = 0, end = unit.blocks[block]?.text.length) {
  const item = unit.blocks[block];
  if (!item || !rectangle?.width || !rectangle?.height) return null;
  const rects = item.words.filter(word => start < word.end && end > word.start).map(({ box }) => project(box, rectangle));
  return rects.length ? { text: item.text.slice(start, end), rects } : null;
}

export function imageWordAtPoint(unit, rectangle, x, y) {
  if (!rectangle?.width || !rectangle?.height) return null;
  for (const [block, item] of unit.blocks.entries()) for (const word of item.words) {
    const rect = project(word.box, rectangle);
    if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom)
      return { block, start: word.start, end: word.end };
  }
  return null;
}
