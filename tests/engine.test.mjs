import test from 'node:test';
import assert from 'node:assert/strict';
import { ReaderEngine } from '../src/engine.js';
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};
class TestAudio extends EventTarget {
  currentTime = 0; paused = true; playbackRate = 1;
  async play() { this.paused = false; this.dispatchEvent(new Event('playing')); }
  pause() { this.paused = true; }
  load() { this.currentTime = 0; }
  set src(value) { this.source = value; this.currentTime = 0; }
  get src() { return this.source; }
  removeAttribute() { this.source = ''; }
}
const result = () => ({ pcm: new Uint8Array(48000), duration: 1, words: [{ word: 'hello', start: 0, end: .8 }] });
const article = { title: 'Test', url: 'https://example.org', blocks: ['hello hello'],
  passages: [{ text: 'hello', block: 0, offset: 0 }, { text: 'hello hello', block: 0, offset: 0 }, { text: 'hello!', block: 0, offset: 0 }] };
const settings = { voiceId: 'voice', model: 'sonic-3.6', apiKey: 'test', speed: 1, mode: 'stream' };
const cache = () => { const map = new Map(); return { get: async k => map.get(k), set: async (k, v) => map.set(k, v) }; };
const until = async predicate => { for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 1)); } throw new Error('Timed out'); };

test('3× rate and pause/resume reuse audio, while stop clears the highlight', async () => {
  let calls = 0, highlight;
  const engine = new ReaderEngine({ audio: new TestAudio(), cache: cache(), generate: async () => { calls++; return result(); }, onHighlight: value => { highlight = value; } });
  engine.load(article, settings); await engine.play(); await engine.fill();
  engine.setSpeed(3); assert.equal(engine.audio.playbackRate, 3); assert.equal(engine.audio.preservesPitch, true);
  const count = calls; engine.pause(); await engine.play(); assert.equal(calls, count);
  engine.audio.currentTime = .3; engine.tick(); assert.equal(highlight.start, 0);
  engine.stop(); engine.audio.dispatchEvent(new Event('timeupdate'));
  assert.equal(highlight, null); assert.equal(engine.state, 'idle');
});

test('stop followed immediately by play ignores a late aborted generation and can restart', async () => {
  let resolveFirst, calls = 0;
  const engine = new ReaderEngine({ audio: new TestAudio(), cache: cache(), generate: async () => {
    calls++; if (calls === 1) return new Promise(resolve => { resolveFirst = resolve; }); return result();
  } });
  engine.load(article, settings); const old = engine.play();
  await until(() => resolveFirst);
  engine.stop(); const restarted = engine.play();
  await until(() => calls > 1); resolveFirst(result());
  await Promise.all([old, restarted]);
  assert.equal(engine.state, 'playing'); assert.equal(engine.audio.paused, false);
  engine.stop();
});

test('word marker holds through timestamp gaps; unmatched words preserve the passage without invented coordinates', async () => {
  const updates = [];
  const engine = new ReaderEngine({ audio: new TestAudio(), cache: cache(), generate: async () => ({ ...result(),
    words: [{ word: 'hello', start: 0, end: .2 }, { word: 'unknown', start: .6, end: .9 }] }), onHighlight: value => updates.push(value) });
  engine.load(article, settings); await engine.play();
  engine.audio.currentTime = .1; engine.tick();
  const count = updates.length;
  engine.audio.currentTime = .4; engine.tick();
  assert.equal(updates.length, count); assert.equal(updates.at(-1).word, 'hello');
  engine.audio.currentTime = .7; engine.tick();
  assert.equal(updates.at(-1).block, 0); assert.equal(updates.at(-1).start, null);
  engine.stop(); assert.equal(updates.at(-1), null);
});

test('replacing the article while an old provider request completes cannot corrupt the new reading', async () => {
  let resolveFirst;
  const engine = new ReaderEngine({ audio: new TestAudio(), cache: cache(), generate: async text => {
    if (text === 'old') return new Promise(resolve => { resolveFirst = resolve; }); return result();
  } });
  engine.load({ ...article, passages: [{ text: 'old', block: 0, offset: 0 }] }, settings);
  const old = engine.play(); await until(() => resolveFirst);
  engine.load(article, settings); await engine.play(); resolveFirst(result()); await old;
  assert.equal(engine.segments[0].text, 'hello'); assert.equal(engine.state, 'playing'); engine.stop();
});

test('Generate all includes skipped earlier passages, and WAV uses exact combined duration', async () => {
  const engine = new ReaderEngine({ audio: new TestAudio(), cache: cache(), generate: async () => result() });
  engine.load(article, settings); await engine.go(2); await engine.prepareAll();
  assert.ok(engine.segments.every(s => s.result));
  const blob = await engine.exportWav(); const view = new DataView(await blob.arrayBuffer());
  assert.equal(view.getUint32(40, true), 3 * 48000);
  await engine.seek(1.4); assert.equal(engine.index, 1); assert.ok(Math.abs(engine.audio.currentTime - .4) < .001); engine.stop();
});

test('ahead mode prepares all audio before playing; errors are surfaced and retryable', async () => {
  let fail = true, count = 0;
  const audio = new TestAudio();
  const engine = new ReaderEngine({ audio, cache: cache(), generate: async () => {
    if (fail) { fail = false; throw new Error('No credits'); }
    assert.equal(audio.paused, true); count++; return result();
  } });
  engine.load(article, { ...settings, mode: 'ahead' });
  await engine.play(); assert.equal(engine.state, 'error'); assert.equal(engine.error, 'No credits');
  await engine.play(); assert.equal(count, 3); assert.equal(engine.state, 'playing'); engine.stop();
});
