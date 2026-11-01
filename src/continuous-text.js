const pageText = unit => unit.blocks.join('\n\n');
const sentenceEnd = /[.!?。！？](?:[”’"')\]]*)(?=\s|$)/g;
export const needsContinuation = unit => !!unit.blocks.at(-1)?.trim() && !/[.!?。！？](?:[”’"')\]]*)\s*$/.test(unit.blocks.at(-1));

// Include a continuation before committing the pending tail to speech. Text
// already assigned to an earlier plan is consumed once, never rewritten later.
export function continuousUnit(unit, following, consumed) {
  if (unit.locations) return unit;
  const blocks = [], locations = [];
  const append = (page, start, end) => {
    let offset = 0;
    for (const [block, text] of page.blocks.entries()) {
      const from = Math.max(start, offset), to = Math.min(end, offset + text.length);
      if (to > from) {
        blocks.push(text.slice(from - offset, to - offset));
        locations.push({ unit: page.id, block, offset: from - offset });
      }
      offset += text.length + 2;
    }
  };
  const text = pageText(unit);
  append(unit, consumed.get(unit.id) || 0, text.length);
  let tail = blocks.at(-1) || '';
  for (const next of following) {
    if (!tail || /[.!?。！？](?:[”’"')\]]*)\s*$/.test(tail)) break;
    const value = pageText(next), match = [...value.matchAll(sentenceEnd)][0];
    const end = match ? match.index + match[0].length : value.length;
    append(next, 0, end); consumed.set(next.id, end);
    tail = match ? '.' : value;
  }
  return { ...unit, blocks, locations, passages: [] };
}

export const fullyConsumed = (unit, consumed) => (consumed.get(unit.id) || 0) >= pageText(unit).length;
