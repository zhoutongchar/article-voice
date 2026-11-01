import test from 'node:test';
import assert from 'node:assert/strict';
import { continuousUnit, fullyConsumed } from '../src/continuous-text.js';
import { prepareReadingUnit } from '../src/reading-preparation.js';
import { ReaderEngine } from '../src/engine.js';
import { ReadingSession } from '../src/reading-session.js';

globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};
class AudioFixture extends EventTarget {
  currentTime = 0; paused = true;
  async play() { this.paused = false; this.dispatchEvent(new Event('playing')); }
  pause() { this.paused = true; }
  load() { this.currentTime = 0; }
  removeAttribute() {}
}
const unit = (id, blocks) => ({ id, blocks, passages: [], source: { format: 'ocr', prefetch: true, pagination: true } });
const settings = { provider: 'local', voiceReferenceId: 'a'.repeat(64), voiceId: 'Ryan', mode: 'stream' };
const until = async predicate => { for (let i = 0; i < 500; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 1)); } throw new Error('Timed out'); };
function formatted(original) {
  let text = '', cursor = 0; const spans = [];
  for (const match of original.matchAll(/-\n+|\n+/g)) {
    if (match.index > cursor) {
      const same = original.slice(cursor, match.index);
      spans.push({ start: text.length, end: text.length + same.length, from: cursor, to: match.index, identity: true }); text += same;
    }
    const next = match[0].startsWith('-') ? '' : ' ';
    spans.push({ start: text.length, end: text.length + next.length, from: match.index, to: match.index + match[0].length, identity: false });
    text += next; cursor = match.index + match[0].length;
  }
  if (cursor < original.length) spans.push({ start: text.length, end: text.length + original.length - cursor, from: cursor, to: original.length, identity: true });
  text += original.slice(cursor);
  return { original, text, spans, id: original, identity: 'fixture' };
}
const cache = { get: async () => null, set: async () => {} };
const clip = text => {
  const words = [...new Intl.Segmenter('en', { granularity: 'word' }).segment(text)].filter(word => word.isWordLike)
    .map((word, i) => ({ word: word.segment, start: i * .1, end: (i + 1) * .1 }));
  return { pcm: new Uint8Array(48000), duration: Math.max(1, words.length * .1), words };
};

test('an unfinished sentence joins the next page before preparation, and its prefix is consumed once', () => {
  const consumed = new Map(), a = unit('a', ['A complete paragraph.', 'We saw a re-']), b = unit('b', ['markable place. The next sentence.']);
  const plan = continuousUnit(a, [b], consumed);
  assert.deepEqual(plan.blocks, ['A complete paragraph.', 'We saw a re-', 'markable place.']);
  assert.deepEqual(plan.locations.at(-1), { unit: 'b', block: 0, offset: 0 });
  const later = continuousUnit(b, [], consumed);
  assert.equal(later.blocks.join(''), ' The next sentence.');
  assert.equal(later.locations[0].offset, 'markable place.'.length);
  assert.equal(fullyConsumed(b, consumed), false);
  assert.deepEqual(continuousUnit(unit('done', ['A complete sentence.']), [b], consumed).blocks, ['A complete sentence.']);
});

test('full OCR page reaches preparation once before splitting, preserving wrap repairs and word click coordinates', async () => {
  const original = unit('page', ['😀 A re-\nmarkable place. ' + 'The familiar story continues naturally. '.repeat(15)]);
  const inputs = [], spoken = [], marks = [];
  const engine = new ReaderEngine({ audio: new AudioFixture(), cache, onHighlight: value => marks.push(value),
    prepare: (unit, settings, signal) => prepareReadingUnit(unit, settings, signal, async text => { inputs.push(text); return formatted(text); }),
    generate: async (text, settings) => { spoken.push(text); assert.ok(settings.preparation); return clip(text); } });
  engine.load(original, settings); await engine.play(); await engine.fill(true);
  assert.deepEqual(inputs, [original.blocks[0]]); assert.ok(engine.segments.length > 1);
  assert.ok(spoken[0].includes('remarkable')); assert.ok(!spoken.join('').includes('re-'));
  const start = original.blocks[0].indexOf('markable');
  await engine.seekWord({ block: 0, start, end: start + 8 });
  assert.equal(marks.at(-1).word, 'remarkable'); assert.equal(marks.at(-1).start, original.blocks[0].indexOf('re-'));
  engine.stop();
});

test('queued continuation is spoken once, changes the visible page at its measured word, and supports source clicks', async () => {
  const a = unit('a', ['We saw a re-']), b = unit('b', ['markable place. A new paragraph waits.']), c = unit('c', ['The last page ends.']);
  let visible = a, session;
  const inputs = [], spoken = [], marks = [], visits = [];
  const engine = new ReaderEngine({ audio: new AudioFixture(), cache,
    prepare: (unit, settings, signal) => prepareReadingUnit(unit, settings, signal, async text => { inputs.push(text); return formatted(text); }),
    generate: async (text, settings) => { spoken.push(text); assert.ok(settings.preparation); return clip(text); },
    onUpdate: value => session?.observe(value), onHighlight: value => marks.push(value) });
  const transport = { request: async message => {
    if (message.type === 'source-next') return (message.after === 'a' ? [b, c] : message.after === 'b' ? [c] : []).slice(0, message.count);
    if (message.type === 'source-present') { visible = [a, b, c].find(unit => unit.id === message.id); visits.push(visible.id); }
    return visible;
  } };
  session = new ReadingSession({ engine, transport, createAudio: () => new AudioFixture() });
  session.load(a, settings); await session.play(); await session.pending;
  assert.equal(inputs[0], 'We saw a re-\n\nmarkable place.');
  assert.equal(spoken.filter(text => text.includes('markable')).length, 1);
  const word = engine.segments[0].result.words.find(word => word.word === 'remarkable');
  engine.audio.currentTime = word.start; engine.tick(); await until(() => visible.id === 'b' && !session.presenting);
  assert.equal(marks.at(-1).block, 0); assert.equal(marks.at(-1).start, 0); assert.equal(marks.at(-1).end, 8);
  await session.seekWord({ block: 0, start: 0, end: 8 });
  assert.equal(engine.audio.currentTime, word.start);
  await engine.next();
  assert.equal(session.unit.id, 'b'); assert.ok(!engine.segments.map(piece => piece.text).join('').includes('markable'));
  assert.equal(visits.filter(id => id === 'b').length, 1);
  await session.stop();
});

test('a page transition plays its ready first sentence while an unfinished background speech request is cancelled', async () => {
  const a = unit('a', ['The first page ends.']), b = unit('b', ['The next page is ready. ' + 'Another sentence follows naturally. '.repeat(25)]);
  let visible = a, session, held = false, cancelled = false;
  const engine = new ReaderEngine({ audio: new AudioFixture(), cache,
    prepare: (unit, settings, signal) => prepareReadingUnit(unit, settings, signal, async text => formatted(text)),
    generate: async (text, settings, signal) => {
      if (text.startsWith('Another') && !held) {
        held = true;
        await new Promise((resolve, reject) => signal.addEventListener('abort', () => { cancelled = true; reject(new DOMException('Cancelled', 'AbortError')); }, { once: true }));
      }
      return clip(text);
    }, onUpdate: value => session?.observe(value) });
  session = new ReadingSession({ engine, createAudio: () => new AudioFixture(), transport: { request: async message => {
    if (message.type === 'source-next') return message.after === 'a' ? [b] : [];
    if (message.type === 'source-present') visible = b;
    return visible;
  } } });
  session.load(a, settings); await session.play(); await until(() => held);
  await engine.next();
  assert.equal(cancelled, true); assert.equal(session.unit.id, 'b'); assert.equal(engine.state, 'playing');
  await session.stop();
});

test('Stop during page preparation cannot publish new passages or start late audio', async () => {
  let release;
  const engine = new ReaderEngine({ audio: new AudioFixture(), cache,
    prepare: async unit => { await new Promise(resolve => { release = resolve; }); return { ...unit, passages: [{ text: 'late', block: 0, offset: 0 }] }; },
    generate: () => assert.fail('Cancelled page must not synthesize') });
  engine.load(unit('a', ['original']), settings);
  const playing = engine.play(); await until(() => release); engine.stop(); release(); await playing;
  assert.equal(engine.state, 'idle'); assert.equal(engine.segments.length, 0); assert.equal(engine.audio.paused, true);
});

test('later page arrival reorganizes an uncommitted tail while earlier narration remains frozen', async () => {
  const pages = [unit('a', ['The opening sentence ends.']), unit('b', ['A second page reaches an un-']),
    unit('c', ['finished thought. The third page reaches a re-']), unit('d', ['markable ending.'])];
  let visible = pages[0], session; const inputs = [];
  const engine = new ReaderEngine({ audio: new AudioFixture(), cache,
    prepare: (unit, settings, signal) => prepareReadingUnit(unit, settings, signal, async text => { inputs.push(text); return formatted(text); }),
    generate: async text => clip(text), onUpdate: value => session?.observe(value) });
  session = new ReadingSession({ engine, createAudio: () => new AudioFixture(), transport: { request: async message => {
    if (message.type === 'source-next') return pages.slice(pages.findIndex(page => page.id === message.after) + 1).slice(0, message.count);
    if (message.type === 'source-present') visible = pages.find(page => page.id === message.id);
    return visible;
  } } });
  session.load(pages[0], settings); await session.play(); await session.pending;
  assert.ok(inputs.some(text => text.includes('un-\n\nfinished')));
  assert.ok(!inputs.some(text => text.includes('re-')), 'The farthest unfinished tail must wait for context');
  const first = engine.segments.map(piece => piece.text).join('');
  await engine.next(); await until(() => inputs.some(text => text.includes('re-\n\nmarkable')));
  assert.equal(inputs.filter(text => text === 'The opening sentence ends.').length, 1);
  assert.equal(first, 'The opening sentence ends.');
  await session.stop();
});
