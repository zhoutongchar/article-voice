import { digest } from '../src/hash.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { artifact, contentFromUnit, contentChunksFromUnit, parseContent, parseSpeech, parseAudio, parseAlignment, planSpeech, sourceRanges, validateContentTransform } from '../src/pipeline/contracts.js';
import { StageScheduler } from '../src/pipeline/scheduler.js';
import { prepareReadingUnit } from '../src/reading-preparation.js';
import { ReaderEngine } from '../src/engine.js';

globalThis.requestAnimationFrame = () => 1; globalThis.cancelAnimationFrame = () => {};
class AudioFixture extends EventTarget {
  currentTime = 0; paused = true;
  async play() { this.paused = false; this.dispatchEvent(new Event('playing')); }
  pause() { this.paused = true; } load() { this.currentTime = 0; } removeAttribute() {}
}
const cache = { get: async () => null, set: async () => {} };
const until = async predicate => { for (let i = 0; i < 500; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 1)); } throw new Error('Timed out'); };
const clip = text => ({ pcm: new Uint8Array(48000), duration: 10, words: [{ word: text, start: 0, end: 9 }] });

test('JavaScript artifacts round-trip through Python validators with identical identities and UTF-16 coordinates', async () => {
  const content = await contentFromUnit({ id: 'page', blocks: ['😀 A whole paragraph. Another sentence.'], source: { format: 'ocr' } });
  const speech = (await planSpeech(content))[0], pcm = new Uint8Array(48000);
  const audio = await artifact('audio', { textDigest: speech.textDigest, format: 'pcm_s16le', sampleRate: 24000, channels: 1, frames: 24000,
    pcmDigest: await digest(pcm), voiceId: 'Ryan', referenceId: 'a'.repeat(64), modelRevision: 'test', generationId: 'b'.repeat(64) });
  const alignment = await artifact('alignment', { audioId: audio.id, textDigest: speech.textDigest, sampleRate: 24000, frames: 24000,
    words: [{ text: 'whole', startSample: 100, endSample: 200, range: { start: 5, end: 10 } }], unmapped: [{ start: 0, end: 5 }, { start: 10, end: speech.text.length }], alignerRevision: 'test' });
  const values = { content, speech, audio, alignment };
  const result = JSON.parse(execFileSync('.venv/bin/python', ['-c', "import json,sys;sys.path.insert(0,'local');import contracts as c;v=json.load(sys.stdin);c.content(v['content']);c.speech(v['speech']);c.audio(v['audio']);c.alignment(v['alignment'],v['speech'],v['audio']);json.dump(v,sys.stdout,ensure_ascii=False)"], { input: JSON.stringify(values), encoding: 'utf8' }));
  await parseContent(result.content); await parseSpeech(result.speech); await parseAudio(result.audio, pcm); await parseAlignment(result.alignment, speech, audio);
  assert.deepEqual(result, values); assert.ok(Object.isFrozen(content.sourceMap));
  await assert.rejects(parseContent({ ...content, text: 'changed' }), /identity changed/);
  await assert.rejects(parseAlignment(await artifact('alignment', { ...Object.fromEntries(Object.entries(alignment).filter(([k]) => !['id', 'kind', 'schemaVersion'].includes(k))), audioId: 'c'.repeat(64) }), speech, audio), /different text or audio/);
  const draft = await artifact('content', { ...Object.fromEntries(Object.entries(content).filter(([k]) => !['id', 'kind', 'schemaVersion'].includes(k))), stability: 'draft' });
  await assert.rejects(planSpeech(draft), /sealed/);
});

test('a long HTML article prepares only the selected paragraph and the formatter can be removed', async () => {
  const blocks = Array.from({ length: 80 }, (_, i) => `Paragraph ${i}. ` + 'A complete sentence follows. '.repeat(12));
  const unit = { id: 'article', blocks, source: { format: 'dom' }, passages: [] }, inputs = [];
  const chunks = await contentChunksFromUnit(unit); assert.equal(chunks.length, blocks.length);
  const engine = new ReaderEngine({ audio: new AudioFixture(), cache,
    prepare: (unit, settings, signal) => prepareReadingUnit(unit, settings, signal, async chunk => { inputs.push(chunk.id); return chunk; }),
    generate: async text => clip(text) });
  engine.load(unit, { provider: 'local', improveText: false, voiceReferenceId: 'a'.repeat(64) });
  await engine.prepareSource(); assert.equal(inputs.length, 0);
  const position = blocks[79].indexOf('complete'); await engine.seekWord({ block: 79, start: position, end: position + 8 });
  assert.equal(inputs.length, 0); assert.equal(engine.index, 79); assert.equal(engine.state, 'playing'); engine.stop();
});

test('dynamic speech planning preserves an already loaded clip when an earlier long paragraph expands', async () => {
  const long = 'A complete sentence stays together. '.repeat(65), unit = { id: 'article', blocks: [long, 'Another paragraph.'], source: { format: 'dom' }, passages: [] };
  const engine = new ReaderEngine({ audio: new AudioFixture(), cache, prepare: (unit, settings, signal) => prepareReadingUnit(unit, settings, signal, async chunk => chunk), generate: async text => clip(text) });
  engine.load(unit, { provider: 'local', improveText: false }); await engine.prepareSource();
  await engine.go(1); const current = engine.segments[1];
  await engine.ensure(0);
  assert.equal(engine.segments[engine.index], current); assert.equal(engine.loadedIndex, engine.index); assert.ok(engine.index > 1);
  engine.stop();
});

test('playable-time buffering scales with speed and has bounded concurrent jobs', async () => {
  let active = 0, maximum = 0;
  const engine = new ReaderEngine({ audio: new AudioFixture(), cache, generate: async text => {
    active++; maximum = Math.max(maximum, active); await new Promise(r => setTimeout(r, 2)); active--; return clip(text);
  } });
  const passages = Array.from({ length: 20 }, (_, i) => ({ block: i, offset: 0, text: `Paragraph ${i}.` }));
  engine.load({ blocks: passages.map(p => p.text), passages }, { provider: 'cartesia', bufferSeconds: 30, speed: 1 });
  await engine.fill(); const first = engine.segments.filter(p => p.result).length;
  assert.ok(first >= 3 && first <= 4); assert.equal(maximum, 2);
  engine.setSpeed(3); await engine.fill();
  assert.ok(engine.segments.filter(p => p.result).length >= 9); assert.ok(engine.bufferedSeconds() >= 30); engine.stop();
});

test('scheduler overlaps independent resources, bounds its queue, and discards late cancelled results', async () => {
  const scheduler = new StageScheduler({ cpu: 1, rpc: 1 }, 2), cancel = new AbortController(); let release;
  const model = scheduler.run('synthesize', 'a', () => new Promise(resolve => { release = resolve; }), { signal: cancel.signal });
  await until(() => release);
  let cpu = false; await scheduler.run('project', 'b', async () => { cpu = true; }, { resource: 'cpu' }); assert.equal(cpu, true);
  const first = scheduler.run('align', 'c', async () => 1), second = scheduler.run('format', 'd', async () => 2);
  await assert.rejects(scheduler.run('format', 'e', async () => 3), { code: 'QUEUE_FULL' });
  cancel.abort(); release('late'); await assert.rejects(model, { name: 'AbortError' }); await Promise.all([first, second]);
  assert.ok(scheduler.snapshot().history.some(job => job.state === 'cancelled'));
});


test('audio beyond an unready gap is not counted as playable time or generated without bound', async () => {
  let release;
  const engine = new ReaderEngine({ audio: new AudioFixture(), cache, generate: async text => {
    if (text === 'First.') await new Promise(resolve => { release = resolve; });
    return clip(text);
  } });
  const passages = Array.from({ length: 30 }, (_, i) => ({ block: i, offset: 0, text: i ? `Later ${i}.` : 'First.' }));
  engine.load({ blocks: passages.map(p => p.text), passages }, { provider: 'cartesia', bufferSeconds: 30 });
  const filling = engine.fill(); await until(() => engine.segments.filter(p => p.result).length >= 3);
  assert.equal(engine.bufferedSeconds(), 0); assert.ok(engine.segments.filter(p => p.result).length <= 4);
  release(); await filling; assert.ok(engine.bufferedSeconds() >= 30); engine.stop();
});

test('artifact hashing has identical identities without secure-context crypto APIs', async () => {
  const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { webcrypto } from 'node:crypto';
    Object.defineProperty(globalThis, 'crypto', { value: { getRandomValues: values => webcrypto.getRandomValues(values) } });
    const { digest, randomId } = await import('./src/hash.js');
    console.log(JSON.stringify({ hash: await digest('Café 😀'), id: randomId() }));
  `], { encoding: 'utf8' }));
  assert.equal(result.hash, await digest('Café 😀')); assert.match(result.id, /^[0-9a-f]{32}$/);
});


test('formatters cannot change stream ownership or invent a source anchor', async () => {
  const original = await contentFromUnit({ id: 'page', blocks: ['A complete paragraph.'] });
  const { id, kind, schemaVersion, ...body } = original;
  const changed = await artifact('content', { ...body, parentIds: [id], streamId: 'another-book' });
  await assert.rejects(validateContentTransform(original, changed), /ownership or order/);
  const invented = await artifact('content', { ...body, parentIds: [id], sourceMap: [{ ...body.sourceMap[0], sources: [{ ...body.sourceMap[0].sources[0], unitId: 'invented-page' }] }] });
  await assert.rejects(validateContentTransform(original, invented), /invented a source/);
});
