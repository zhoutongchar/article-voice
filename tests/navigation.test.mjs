import test from 'node:test';
import assert from 'node:assert/strict';
import { ReaderEngine } from '../src/engine.js';
import { sourceSpan } from '../src/alignment.js';
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};
class TestAudio extends EventTarget {
  currentTime = 0; paused = true; playbackRate = 1;
  async play() { this.paused = false; this.dispatchEvent(new Event('playing')); }
  pause() { this.paused = true; }
  load() { this.currentTime = 0; }
  set src(value) { this.source = value; this.currentTime = 0; }
  removeAttribute() { this.source = ''; }
}
const blocks = ['alpha beta', 'gamma delta', 'epsilon zeta'];
const article = { title: 'Navigation', url: 'https://example.org', blocks,
  passages: blocks.map((text, block) => ({ text, block, offset: 0 })) };
const settings = { voiceId: 'voice', model: 'sonic-3.6', apiKey: 'test', speed: 3, mode: 'stream' };
const audioFor = text => ({ pcm: new Uint8Array(72000), duration: 1.5,
  words: text.split(' ').map((word, i) => ({ word, start: i * .5, end: i * .5 + .4 })) });
const cache = () => { const map = new Map(); return { get: async k => map.get(k), set: async (k, v) => map.set(k, v) }; };
const until = async predicate => { for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 1)); } throw new Error('Timed out'); };

test('source coordinates use the same interpretation for generated passages and imported recordings', () => {
  assert.deepEqual(sourceSpan({ block: 2, offset: 20 }, { from: 4, to: 8 }), { block: 2, start: 24, end: 28 });
  assert.deepEqual(sourceSpan({ block: 0, offset: 20 }, { block: 2, from: 4, to: 8 }), { block: 2, start: 4, end: 8 });
  assert.deepEqual(sourceSpan({ block: 2, offset: 20 }, { from: null, to: null }), { block: 2, start: null, end: null });
});

test('clicking an ungenerated word starts exactly there; backward and forward jumps retain 3× and reuse audio', async () => {
  let calls = 0, highlight;
  const engine = new ReaderEngine({ audio: new TestAudio(), cache: cache(), generate: async text => { calls++; return audioFor(text); },
    onHighlight: value => { highlight = value; } });
  engine.load(article, settings);
  await engine.seekWord({ block: 2, start: 8, end: 12 });
  assert.equal(engine.index, 2); assert.equal(engine.audio.currentTime, .5); assert.equal(engine.state, 'playing');
  assert.equal(engine.audio.playbackRate, 3); assert.equal(highlight.start, 8);
  await engine.seekWord({ block: 0, start: 6, end: 10 });
  assert.equal(engine.index, 0); assert.equal(engine.audio.currentTime, .5); assert.equal(highlight.word, 'beta');
  await engine.fill(); const count = calls;
  engine.pause(); await engine.seekWord({ block: 2, start: 0, end: 7 });
  assert.equal(engine.index, 2); assert.equal(engine.audio.currentTime, 0); assert.equal(engine.state, 'playing');
  const source = engine.audio.source;
  await engine.seekWord({ block: 2, start: 8, end: 12 });
  assert.equal(engine.audio.source, source, 'Seeking within a passage retains its loaded media source');
  assert.equal(calls, count); engine.stop();
});

test('click navigation works across source blocks in a reopened WAV recording', async () => {
  const engine = new ReaderEngine({ audio: new TestAudio(), cache: cache(), generate: async text => audioFor(text) });
  engine.load(article, settings); await engine.prepareAll();
  const recording = await engine.exportWav(); await engine.openRecording(recording);
  await engine.seekWord({ block: 2, start: 8, end: 12 });
  assert.equal(engine.index, 0); assert.equal(engine.audio.currentTime, 3.5); assert.equal(engine.state, 'playing');
  await engine.seekWord({ block: 0, start: 6, end: 10 });
  assert.equal(engine.audio.currentTime, .5); assert.equal(engine.lastWord, 'beta'); engine.stop();
});

test('a later click wins when the previous word is still generating', async () => {
  let resolveFirst;
  const engine = new ReaderEngine({ audio: new TestAudio(), cache: cache(), generate: async text => {
    if (text === blocks[0]) return new Promise(resolve => { resolveFirst = resolve; }); return audioFor(text);
  } });
  engine.load(article, settings);
  const first = engine.seekWord({ block: 0, start: 0, end: 5 }); await until(() => resolveFirst);
  await engine.seekWord({ block: 1, start: 6, end: 11 }); resolveFirst(audioFor(blocks[0])); await first;
  assert.equal(engine.index, 1); assert.equal(engine.audio.currentTime, .5); assert.equal(engine.lastWord, 'delta');
  assert.equal(engine.state, 'playing'); engine.stop();
});

test('missing timings remain explicit and invalid source coordinates do not initiate generation', async () => {
  let calls = 0;
  const engine = new ReaderEngine({ audio: new TestAudio(), cache: cache(), generate: async text => { calls++; return { ...audioFor(text), words: [] }; } });
  engine.load(article, settings);
  assert.throws(() => engine.seekWord({ block: -1, start: 0, end: 5 }), /no longer available/);
  assert.throws(() => engine.seekWord({ block: 0, start: 0, end: 500 }), /no longer available/);
  assert.equal(calls, 0);
  await engine.seekWord({ block: 0, start: 0, end: 5 });
  assert.equal(engine.state, 'error'); assert.match(engine.error, /No word timing/); engine.stop();
});
