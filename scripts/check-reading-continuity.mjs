// Real speech/format/alignment replay, without Chrome or the installed extension.
// Optional baseline modules come from a caller-selected, local Git revision.
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { localFormatContent, localSynthesize } from '../src/local.js';
import { contentChunksFromUnit } from '../src/pipeline/contracts.js';
import { pcmWav } from '../src/cartesia.js';
import { ReaderEngine } from '../src/engine.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const { values } = parseArgs({ options: {
  ocr: { type: 'string' }, baseline: { type: 'string' }, port: { type: 'string', default: '4324' },
  output: { type: 'string', default: 'test-results/reading-continuity' },
  'bypass-formatter': { type: 'boolean', default: false }
} });
const port = Number(values.port);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Choose a valid loopback port');
const output = path.resolve(root, values.output);
await fs.mkdir(output, { recursive: true });
const fetcher = (url, options) => fetch(String(url).replace('127.0.0.1:4318', `127.0.0.1:${port}`), options);
const catalog = await (await fetcher('http://127.0.0.1:4318/voices')).json();
const reference = catalog.voices.find(v => v.id === 'Ryan')?.referenceId;
if (!reference) throw new Error('Open Article Voice to prepare Ryan, then retry');
const fixtureLine = (text, x, y) => {
  const box = { x, y, width: .38, height: .04 };
  return { text, box, words: [...text.matchAll(/\S+/g)].map(match => ({ start: match.index, end: match.index + match[0].length, box })) };
};
const vision = values.ocr ? JSON.parse(await fs.readFile(path.resolve(values.ocr), 'utf8')) : {
  width: 2000, height: 1000, lines: [
    fixtureLine('An earlier paragraph ends.', .065, .05),
    fixtureLine('We approach another gate that creaks', .065, .10),
    fixtureLine('with the sound of metal on metal.', .55, .05),
    fixtureLine('A different paragraph ends.', .565, .10),
    fixtureLine('The last line is complete.', .55, .15)
  ]
};
async function modules(ref) {
  const load = async file => {
    if (!ref) return import(pathToFileURL(path.join(root, file)).href);
    const original = execFileSync('git', ['show', `${ref}:${file}`], { cwd: root, encoding: 'utf8' });
    const source = original.replace(/from '([^']+)'/g, (_, relative) =>
      `from ${JSON.stringify(pathToFileURL(path.resolve(root, path.dirname(file), relative)).href)}`);
    return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  };
  return { ...await load('src/sources/ocr.js'), ...await load('src/continuous-text.js'), ...await load('src/reading-preparation.js'), ...await load('src/reading-session.js') };
}
async function replay(label, ref) {
  const { ocrBlocks, continuousUnit, prepareReadingUnit } = await modules(ref);
  const blocks = ocrBlocks(vision);
  const unit = { id: 'continuity-replay', source: { format: 'ocr' }, blocks: blocks.map(b => b.text) };
  unit.contentChunks = await contentChunksFromUnit({ ...unit, stability: 'draft' });
  const assembled = continuousUnit(unit, [], new Map());
  const cache = new Map(), events = [];
  const settings = { provider: 'local', voiceId: 'Ryan', voiceReferenceId: reference, language: 'en', priority: 1,
    improveText: !values['bypass-formatter'],
    stageCache: { get: async key => cache.get(key), set: async (key, value) => cache.set(key, value) },
    onStage: event => { if (event.state === 'result') events.push(event); } };
  const article = await prepareReadingUnit(assembled, settings, undefined,
    (content, context) => localFormatContent(content, { ...settings, ...context }, fetcher));
  const passages = article.passages.filter(p => /creaks|metal on metal/.test(p.text));
  if (!passages.length) throw new Error('OCR input must contain the reported creaks / metal on metal boundary');
  const clips = [];
  for (const passage of passages) {
    console.log(`${label}: ${passage.text.length}-character speech request`);
    const clip = await localSynthesize(passage.text, { ...settings, speechChunk: passage.speechChunk, sourceContent: passage.sourceContent }, undefined, fetcher);
    clips.push({ passage, clip, mappedWords: article.align(passage, clip.words) });
  }
  const pcm = new Uint8Array(clips.reduce((sum, c) => sum + c.clip.pcm.length, 0));
  const words = []; let byte = 0, time = 0;
  for (const { clip, mappedWords } of clips) {
    pcm.set(clip.pcm, byte); byte += clip.pcm.length;
    words.push(...mappedWords.map(word => ({ ...word, start: time + word.start, end: time + word.end })));
    time += clip.duration;
  }
  const index = words.findIndex(w => /^creaks$/i.test(w.word));
  const left = words[index], right = words[index + 1];
  if (!left || right?.word.toLowerCase() !== 'with') throw new Error('Alignment did not preserve the target word order');
  const phraseStart = words.slice(0, index).findLast(word => word.word.toLowerCase() === 'another');
  const phraseEnd = words.slice(index + 1).filter(word => /^metal\W*$/i.test(word.word))[1];
  const start = Math.floor(Math.max(0, (phraseStart?.start ?? left.start - 2) - .1) * 24000) * 2;
  const end = Math.ceil(Math.min(time, (phraseEnd?.end ?? right.end + 4) + .15) * 24000) * 2;
  await fs.writeFile(path.join(output, `${label}-boundary.wav`), new Uint8Array(await pcmWav(pcm.slice(start, end)).arrayBuffer()));
  const result = { label, revision: ref || 'working tree', input: values.ocr || 'synthetic OCR layout',
    paragraphCount: blocks.length, events,
    speech: clips.map(({ passage, clip, mappedWords }) => ({ text: passage.text, content: passage.sourceContent,
      speech: passage.speechChunk, audio: clip.audioArtifact, alignment: clip.alignment, playable: clip.playable, mappedWords })),
    boundary: { left, right, requests: clips.length, alignedGapSeconds: right.start - left.end } };
  await fs.writeFile(path.join(output, `${label}.json`), JSON.stringify(result, null, 2));
  return { summary: { label, paragraphs: blocks.length, targetRequests: clips.length, alignedGapSeconds: result.boundary.alignedGapSeconds }, result };
}
const results = [];
if (values.baseline) results.push((await replay('before', values.baseline)).summary);
const current = await replay('after'); results.push(current.summary);

// Controlled presentation latency is separate from real PCM/word-gap evidence.
// Use measured word timings with an Audio fixture; never claim this is browser playback.
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};
class AudioFixture extends EventTarget {
  currentTime = 0; paused = true; pauses = 0;
  pause() { this.paused = true; this.pauses++; }
  async play() { this.paused = false; this.dispatchEvent(new Event('playing')); }
  load() { this.currentTime = 0; }
  removeAttribute() {}
}
const until = async predicate => { for (let i = 0; i < 1000; i++) { if (predicate()) return; await new Promise(resolve => setImmediate(resolve)); } throw new Error('Controlled presentation did not settle'); };
async function presentation(ref) {
  const { ReadingSession, prepareReadingUnit } = await modules(ref);
  const measured = current.result.speech.find(part => /creaks.*with/s.test(part.text));
  const boundary = measured.text.indexOf('with', measured.text.indexOf('creaks'));
  const page = (id, text) => ({ id, blocks: [text], passages: [], source: { format: 'ocr', prefetch: true, pagination: true } });
  const a = page('a', measured.text.slice(0, boundary).trimEnd()), b = page('b', measured.text.slice(boundary));
  b.blocks.push('A later paragraph ends.');
  const words = measured.alignment.words.map(w => ({ word: w.text, start: w.startSample / 24000, end: w.endSample / 24000, from: w.range?.start, to: w.range?.end }));
  let session, release, visible = a; const errors = [];
  const audio = new AudioFixture(), settings = { provider: 'local', improveText: false, speed: 3, voiceId: 'Ryan' };
  const engine = new ReaderEngine({ audio, cache: { get: async () => null, set: async () => {} },
    prepare: (unit, settings, signal) => prepareReadingUnit(unit, settings, signal),
    generate: async text => text.includes('creaks') ? { pcm: new Uint8Array(2), duration: measured.audio.frames / 24000, words }
      : { pcm: new Uint8Array(2), duration: 1, words: [{ word: 'A', start: 0, end: .1, from: 0, to: 1 }] },
    onUpdate: state => session?.observe(state) });
  session = new ReadingSession({ engine, onError: error => errors.push(error), createAudio: () => new AudioFixture(), transport: { request: async message => {
    if (message.type === 'source-next') return message.after === 'a' ? [b] : [];
    if (message.type === 'source-present') { await new Promise(resolve => { release = resolve; }); visible = b; }
    return visible;
  } } });
  session.load(a, settings); await session.play(); await session.pending;
  if (errors.length) throw errors[0];
  audio.currentTime = words.find(w => w.word.toLowerCase() === 'with').start;
  const before = audio.pauses, time = audio.currentTime;
  engine.tick(); await until(() => release);
  if (!audio.paused) audio.currentTime += .25 * engine.speed;
  const result = { pausesDuringPresentation: audio.pauses - before, audioSecondsAdvancedDuringInjected250ms: audio.currentTime - time };
  release(); await until(() => !session.presenting); await session.stop(); return result;
}
const navigation = { method: 'Controlled Audio fixture with real model word timings; no browser playback',
  ...(values.baseline ? { before: await presentation(values.baseline) } : {}), after: await presentation() };
if (navigation.after.pausesDuringPresentation !== 0 || navigation.after.audioSecondsAdvancedDuringInjected250ms <= 0)
  throw new Error('Ready audio was interrupted by page presentation');
await fs.writeFile(path.join(output, 'presentation.json'), JSON.stringify(navigation, null, 2));
await fs.writeFile(path.join(output, 'summary.json'), JSON.stringify(results, null, 2));
console.log(JSON.stringify({ audio: results, navigation }, null, 2));
