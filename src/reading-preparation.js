import { splitPassages } from './article.js';
import { preparedTextProjection } from './prepared-text.js';
import { localPrepareText } from './local.js';
import { alignWords } from './alignment.js';

// The page owns preparation; speech pieces are created only after it finishes.
// Original blocks and OCR coordinates never become narration coordinates.
export async function prepareReadingUnit(unit, settings, signal, prepare = localPrepareText) {
  if (settings.provider !== 'local' || unit.source?.format !== 'ocr') return unit;
  let position = 0;
  const blocks = unit.blocks.map((text, block) => {
    const result = { block, start: position, end: position + text.length };
    position = result.end + 2; return result;
  });
  const original = unit.blocks.join('\n\n');
  if (!original.trim()) return { ...unit, passages: [] };
  const record = await prepare(original, signal);
  if (record.original !== original || typeof record.id !== 'string') throw new Error('The prepared page does not match this reading.');
  const projection = preparedTextProjection(record);
  const ranges = (start, end) => {
    const source = projection.source(start, end);
    return source ? blocks.filter(block => source.start < block.end && source.end > block.start)
      .map(block => ({ block: block.block, start: Math.max(source.start, block.start) - block.start,
        end: Math.min(source.end, block.end) - block.start })) : [];
  };
  // Preserve complete sentences when possible. The first sentence remains a
  // separate piece for startup; later pieces amortize voice/aligner overhead.
  const passages = splitPassages([{ text: record.text }], 480).map(piece => {
    const sourceRanges = ranges(piece.offset, piece.offset + piece.text.length);
    return { text: piece.text, preparedOffset: piece.offset, sourceRanges,
      block: sourceRanges[0]?.block ?? 0, offset: sourceRanges[0]?.start ?? 0,
      preparation: { id: record.id, original: record.original, start: piece.offset, end: piece.offset + piece.text.length } };
  });
  return { ...unit, passages, preparation: record,
    align: (segment, words) => alignWords(segment.text, words).map(word => {
      const source = word.from == null ? [] : ranges(segment.preparedOffset + word.from, segment.preparedOffset + word.to);
      // Preserve every recognized fragment when a repaired word spans pages.
      // Show its final fragment; either fragment can seek the measured word.
      const primary = source.at(-1);
      return primary ? { ...word, block: primary.block, from: primary.start, to: primary.end,
        sources: source.map(range => ({ block: range.block, from: range.start, to: range.end })) }
        : { ...word, from: null, to: null };
    }) };
}
