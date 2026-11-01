// Spoken text and page text are different coordinate spaces. Validate their
// mapping once at the boundary, then use it for both highlights and seeks.
export function preparedTextProjection(record) {
  if (typeof record?.original !== 'string' || typeof record.text !== 'string' || !Array.isArray(record.spans))
    throw new Error('Invalid prepared text');
  const spans = record.spans.map(span => ({ ...span }));
  let prepared = 0, source = 0;
  for (const span of spans) {
    if (![span.start, span.end, span.from, span.to].every(Number.isInteger)
      || span.start !== prepared || span.from !== source || span.end < span.start || span.to < span.from
      || span.end === span.start && span.to === span.from
      || span.end > record.text.length || span.to > record.original.length || typeof span.identity !== 'boolean'
      || span.identity && record.text.slice(span.start, span.end) !== record.original.slice(span.from, span.to))
      throw new Error('Invalid prepared text mapping');
    prepared = span.end; source = span.to;
  }
  if (!spans.length || prepared !== record.text.length || source !== record.original.length)
    throw new Error('Incomplete prepared text mapping');
  const project = (start, end, reverse) => {
    const length = reverse ? record.original.length : record.text.length;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > length) return null;
    const hits = [];
    for (const span of spans) {
      const a = reverse ? span.from : span.start, b = reverse ? span.to : span.end;
      const c = reverse ? span.start : span.from, d = reverse ? span.end : span.to;
      if (start < b && end > a) hits.push(span.identity
        ? { start: c + Math.max(start, a) - a, end: c + Math.min(end, b) - a } : { start: c, end: d });
    }
    const visible = hits.filter(hit => hit.end > hit.start);
    return visible.length ? { start: visible[0].start, end: visible.at(-1).end } : null;
  };
  return { source: (start, end) => project(start, end, false), prepared: (start, end) => project(start, end, true) };
}
