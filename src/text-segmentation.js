import speechPolicy from '../local/speech-policy.json' with { type: 'json' };
// A soft target: only unusually long paragraphs are grouped into complete
// sentences. A single long sentence stays intact, never cut at a word count.
export const PARAGRAPH_CHARACTERS = speechPolicy.paragraphCharacters;
const abbreviation = new RegExp(`\\b(?:${speechPolicy.abbreviations.map(value => value.replaceAll('.', '\\.')).join('|')}|\\p{L})\\.$`, 'iu');
export function sentencePassages(text) {
  const result = [];
  const append = (start, end) => {
    const raw = text.slice(start, end), value = raw.trim();
    if (value) result.push({ text: value, offset: start + raw.indexOf(value) });
  };
  if (text.length <= PARAGRAPH_CHARACTERS) { append(0, text.length); return result; }
  const ends = [];
  for (const match of text.matchAll(/[.!?。！？]+[”’"')\]]*/gu)) {
    const end = match.index + match[0].length;
    if (end < text.length && !/\s/.test(text[end]) && !/[。！？]/u.test(match[0])) continue;
    const prefix = text.slice(0, end).replace(/[”’"')\]]+$/u, '');
    if (prefix.endsWith('.') && abbreviation.test(prefix)) continue;
    ends.push(end);
  }
  if (ends.at(-1) !== text.length) ends.push(text.length);
  let start = 0, previous = 0;
  for (const end of ends) {
    if (end - start > PARAGRAPH_CHARACTERS && previous > start) {
      append(start, previous); start = previous;
    }
    previous = end;
  }
  append(start, text.length);
  return result;
}

// Source paragraphs own speech boundaries. Visual line wraps never create
// requests. OCR asks for whole paragraphs until its full-window LLM has run.
export function paragraphPassages(blocks, { splitLong = true } = {}) {
  const result = [];
  for (const [block, item] of blocks.entries()) {
    let start = 0;
    const append = end => {
      const raw = item.text.slice(start, end), text = raw.trim();
      if (!text) return;
      const offset = start + raw.indexOf(text);
      const pieces = splitLong ? sentencePassages(text) : [{ text, offset: 0 }];
      result.push(...pieces.map(piece => ({ block, offset: offset + piece.offset, text: piece.text })));
    };
    for (const boundary of item.text.matchAll(/\r?\n[ \t]*\r?\n/g)) {
      append(boundary.index); start = boundary.index + boundary[0].length;
    }
    append(item.text.length);
  }
  return result;
}
