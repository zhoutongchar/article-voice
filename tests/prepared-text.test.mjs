import test from 'node:test';
import assert from 'node:assert/strict';
import { preparedTextProjection } from '../src/prepared-text.js';
import { alignWords } from '../src/alignment.js';

const record = { original: '😀 state st remains.', text: '😀 state s sub t remains.', spans: [
  { start: 0, end: 9, from: 0, to: 9, identity: true },
  { start: 9, end: 16, from: 9, to: 11, identity: false },
  { start: 16, end: 25, from: 11, to: 20, identity: true }
] };

test('aligned spoken words project onto the original expression, including UTF-16 offsets', () => {
  const projection = preparedTextProjection(record);
  const words = alignWords(record.text, [{ word: 'state', start: .1, end: .8 }, { word: 's', start: 1, end: 1.1 }, { word: 'sub', start: 1.1, end: 1.3 },
    { word: 't', start: 1.3, end: 1.4 }, { word: 'remains', start: 1.4, end: 2 }]);
  assert.deepEqual(words.slice(1, 4).map(word => projection.source(word.from, word.to)), [
    { start: 9, end: 11 }, { start: 9, end: 11 }, { start: 9, end: 11 }
  ]);
  assert.deepEqual(projection.source(words[4].from, words[4].to), { start: 12, end: 19 });
  assert.deepEqual(projection.prepared(10, 11), { start: 9, end: 16 });
  assert.deepEqual(projection.prepared(12, 19), { start: 17, end: 24 });
});

test('mapping rejects gaps, overlaps, altered prose and incomplete source coverage', () => {
  for (const change of [s => s[1].start++, s => s[1].from--, s => s[1].to++, s => s.pop(), s => s[1].identity = true]) {
    const value = structuredClone(record); change(value.spans);
    assert.throws(() => preparedTextProjection(value), /mapping/);
  }
  const projection = preparedTextProjection(record);
  assert.equal(projection.source(0, 99), null);
  assert.equal(projection.prepared(-1, 3), null);
});
