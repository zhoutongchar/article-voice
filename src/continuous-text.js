const pageText = unit => unit.blocks.join('\n\n');
export const needsContinuation = unit => !!unit.blocks.at(-1)?.trim() && !/[.!?。！？](?:[”’"')\]]*)\s*$/.test(unit.blocks.at(-1));

// Include a continuation before committing the pending tail to speech. Text
// already assigned to an earlier plan is consumed once, never rewritten later.
export function continuousUnit(unit, following, consumed) {
  if (unit.locations) return unit;
  const blocks = [], locations = [], separators = [], parents = new Set();
  const append = (page, start, end, continuation = false) => {
    for (const chunk of page.contentChunks || []) parents.add(chunk.id);
    let offset = 0;
    for (const [block, text] of page.blocks.entries()) {
      const from = Math.max(start, offset), to = Math.min(end, offset + text.length);
      if (to > from) {
        if (blocks.length) separators.push(continuation ? '\n' : '\n\n');
        continuation = false;
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
    // The first block is the continuing paragraph, not merely its first
    // sentence. Keep the page boundary as a visual line wrap for preparation.
    const end = next.blocks[0]?.length || 0;
    append(next, 0, end, true); consumed.set(next.id, end);
    tail = next.blocks.length > 1 ? '.' : next.blocks[0];
  }
  return { ...unit, blocks, locations, separators, parentIds: [...parents], stability: 'sealed', streamId: unit.contentChunks?.[0]?.streamId, sequence: unit.contentChunks?.[0]?.sequence || 0, passages: [] };
}

export const fullyConsumed = (unit, consumed) => (consumed.get(unit.id) || 0) >= pageText(unit).length;
