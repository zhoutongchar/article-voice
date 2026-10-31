const canonical = value => value.normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

// Request original (not spoken-normalized) timestamps. Align monotonically,
// preserving source offsets; never invent a moving highlight for unknown words.
export function alignWords(text, words) {
  const characters = [], positions = [];
  for (let index = 0; index < text.length;) {
    const char = String.fromCodePoint(text.codePointAt(index));
    const normalized = canonical(char);
    for (let unit = 0; unit < normalized.length; unit++) {
      characters.push(normalized[unit]); positions.push({ start: index, end: index + char.length });
    }
    index += char.length;
  }
  const source = characters.join('');
  let cursor = 0;
  return words.map(item => {
    const target = canonical(item.word);
    const found = target ? source.indexOf(target, cursor) : -1;
    if (found < 0) return { ...item, from: null, to: null };
    const first = positions[found], last = positions[found + target.length - 1];
    cursor = found + target.length;
    return { ...item, from: first.start, to: last.end };
  });
}

// A read-along marker represents the reading position. Hold the last started
// word through breath/punctuation gaps, then move when the next word starts.
export function wordAtPosition(words, time) {
  let low = 0, high = words.length - 1, found = -1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    if (words[mid].start <= time) { found = mid; low = mid + 1; } else high = mid - 1;
  }
  return found >= 0 ? words[found] : null;
}

// Generated passage timings are relative to a passage; imported recordings
// already carry absolute source coordinates. Interpret that distinction once.
export function sourceSpan(segment, word) {
  const offset = word.block == null ? segment.offset : 0;
  return { block: word.block ?? segment.block,
    start: word.from == null ? null : word.from + offset,
    end: word.to == null ? null : word.to + offset };
}
