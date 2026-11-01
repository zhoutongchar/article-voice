import { paragraphPassages, sentencePassages } from './article.js';
import { preparedTextProjection } from './prepared-text.js';
import { localPrepareText } from './local.js';
import { alignWords } from './alignment.js';

// The page owns preparation; speech pieces are created only after it finishes.
// Original blocks and OCR coordinates never become narration coordinates.
export async function prepareReadingUnit(unit, settings, signal, prepare = localPrepareText) {
  if (settings.provider !== 'local' || unit.source?.format !== 'ocr') return unit;
  let position = 0;
  const parts = [];
  const blocks = unit.blocks.map((text, block) => {
    if (block) { const separator = unit.separators?.[block - 1] ?? '\n\n'; parts.push(separator); position += separator.length; }
    parts.push(text);
    const result = { block, start: position, end: position + text.length };
    position = result.end; return result;
  });
  const original = parts.join('');
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
  // Project SOURCE paragraph boundaries through the LLM's mapping. Neither
  // a flattened blank line nor a new line inserted by the model may split or
  // merge speech requests. Page-continuation fragments share one paragraph.
  const passages = paragraphPassages([{ text: original }], { splitLong: false }).flatMap(paragraph => {
    const prepared = projection.prepared(paragraph.offset, paragraph.offset + paragraph.text.length);
    if (!prepared) throw new Error('A prepared paragraph lost its source text.');
    const raw = record.text.slice(prepared.start, prepared.end), text = raw.trim();
    const offset = prepared.start + raw.indexOf(text);
    return sentencePassages(text).map(part => {
      const piece = { text: part.text, offset: offset + part.offset };
      const sourceRanges = ranges(piece.offset, piece.offset + piece.text.length);
      return { text: piece.text, preparedOffset: piece.offset, sourceRanges,
        block: sourceRanges[0]?.block ?? 0, offset: sourceRanges[0]?.start ?? 0,
        preparation: { id: record.id, original: record.original, start: piece.offset, end: piece.offset + piece.text.length } };
    });
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
