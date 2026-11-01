import test from 'node:test';
import assert from 'node:assert/strict';
import { createSource, isImageSourceUrl } from '../src/sources/registry.js';
import { createPagedImageSource } from '../src/sources/paged-image.js';
import { SourceHost } from '../src/sources/host.js';
import { ocrBlocks, imageSpan, imageWordAtPoint } from '../src/sources/ocr.js';
import { StageScheduler } from '../src/pipeline/scheduler.js';
import { ReaderEngine } from '../src/engine.js';
import { ReadingSession } from '../src/reading-session.js';

globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};
const until = async fn => { for (let i = 0; i < 500; i++) { if (fn()) return; await new Promise(resolve => setTimeout(resolve, 1)); } throw new Error('Timed out'); };
const box = (x, y, width = .2) => ({ x, y, width, height: .04 });
const line = (text, x = .05, y = .05) => ({ text, box: box(x, y), words: [{ start: 0, end: text.length, box: box(x, y) }] });
function pages(recognize = async image => ({ lines: [line(`page ${image}`)] })) {
  let index = 0, covered = false, disposed = false;
  const visits = [];
  const capture = async () => ({ id: `page-${index}`, image: String(index), title: 'Book', url: 'https://example.org/book', label: `Page ${index + 1}` });
  const access = { capture, async turn(direction) { if (index + direction < 0 || index + direction > 5) return null; index += direction; visits.push(index); return capture(); },
    cover() { covered = true; }, uncover() { covered = false; }, rectangle() { return { left: 10, top: 20, width: 800, height: 600 }; }, dispose() { disposed = true; } };
  const adapter = createPagedImageSource({ id: 'test-book', access, recognize });
  return { adapter, access, visits, get index() { return index; }, get covered() { return covered; }, get disposed() { return disposed; } };
}

test('registry selects a site adapter before the article fallback and accepts new source types without changing the player', () => {
  const custom = { id: 'transcript', matches: ({ url }) => url.hostname === 'video.example', create: () => ({ id: 'transcript' }) };
  assert.equal(createSource({ url: new URL('https://video.example/watch') }, [custom, { matches: () => true, create: () => ({ id: 'article' }) }]).id, 'transcript');
  assert.equal(isImageSourceUrl('https://read.amazon.com/?asin=book'), true);
  assert.equal(isImageSourceUrl('https://read.amazon.com.evil.example/?asin=book'), false);
  assert.equal(isImageSourceUrl('https://en.wikipedia.org/wiki/Book'), false);
});

test('OCR boundary keeps UTF-16 offsets, column order and image-relative word hit testing', () => {
  const wrapped = ocrBlocks({ lines: [line('re-', .05, .05), line('markable', .05, .10)] });
  assert.equal(wrapped.length, 1); assert.equal(wrapped[0].text, 're-\nmarkable');
  assert.equal(wrapped[0].words[1].start, 4);
  const blocks = ocrBlocks({ lines: [line('right one', .55, .05), line('left two', .05, .15), line('left one', .05, .05), line('right two', .55, .15)] });
  assert.deepEqual(blocks.map(block => block.text), ['left one', 'left two', 'right one', 'right two']);
  const unit = { blocks }, rect = { left: 10, top: 20, width: 1000, height: 800 };
  assert.deepEqual(imageWordAtPoint(unit, rect, 70, 70), { block: 0, start: 0, end: 8 });
  assert.equal(imageSpan(unit, rect, 0, 0, 8).rects[0].left, 60);
  assert.equal(imageWordAtPoint(unit, rect, 500, 400), null);
  assert.throws(() => ocrBlocks({ lines: [{ ...line('😀 word'), words: [{ start: 0, end: 99, box: box(.1, .1) }] }] }), /word coordinates/);
  assert.throws(() => ocrBlocks({ lines: [{ ...line('word'), box: box(-1, .1) }] }), /page coordinates/);
});

test('source host prepares two units, restores the visible page and retains bounded history as reading advances', async () => {
  const fixture = pages(), host = new SourceHost(fixture.adapter);
  const first = await host.open(); assert.equal(first.source.id, 'test-book');
  assert.equal(first.contentChunks[0].stability, 'draft');
  const next = await host.prepareNext(first.id);
  assert.deepEqual(next.map(unit => unit.blocks), [['page 1'], ['page 2']]);
  assert.deepEqual([first, ...next].flatMap(unit => unit.contentChunks.map(chunk => chunk.sequence)), [0, 1, 2]);
  assert.equal(fixture.index, 0); assert.equal(fixture.covered, false);
  await host.present(next[0].id); assert.equal(fixture.index, 1);
  await host.prepareNext(next[0].id); assert.equal(fixture.index, 1);
  await host.present(next[1].id); assert.equal(fixture.index, 2);
  assert.equal(fixture.adapter.has(first.id), false);
  await host.dispose(); assert.equal(fixture.disposed, true);
});

test('opening follows a page that changes during OCR instead of publishing stale word coordinates', async () => {
  const fixture = pages(async image => {
    if (image === '0') await fixture.access.turn(1);
    return { lines: [line(`page ${image}`)] };
  });
  const unit = await fixture.adapter.open();
  assert.equal(unit.id, 'page-1'); assert.equal(unit.blocks[0].text, 'page 1');
  assert.equal(fixture.index, 1); await fixture.adapter.dispose();
});

test('cancel during future-page OCR restores the source before cleanup finishes and permits retry', async () => {
  let started, blocked = true;
  const fixture = pages((image, signal) => image === '0' || !blocked ? Promise.resolve({ lines: [line('current')] })
    : new Promise((resolve, reject) => { started = resolve; signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true }); }));
  const first = await fixture.adapter.open();
  const pending = fixture.adapter.prepareNext(first.id).catch(error => error);
  await until(() => started); await fixture.adapter.cancel();
  assert.equal((await pending).name, 'AbortError'); assert.equal(fixture.index, 0); assert.equal(fixture.covered, false);
  blocked = false; assert.equal((await fixture.adapter.prepareNext(first.id)).length, 2);
  await fixture.adapter.dispose(); assert.equal(fixture.disposed, true);
});

test('OCR failure after turning records actual position and restores it; failed restoration releases the UI with an explicit error', async () => {
  const fixture = pages(async image => { if (image !== '0') throw new Error('OCR failed'); return { lines: [line('current')] }; });
  const first = await fixture.adapter.open();
  await assert.rejects(fixture.adapter.prepareNext(first.id), /OCR failed/);
  assert.equal(fixture.index, 0); assert.equal(fixture.covered, false);
  const turn = fixture.access.turn;
  fixture.access.turn = async direction => { await turn(direction); return { id: 'unexpected', image: 'other' }; };
  await assert.rejects(fixture.adapter.prepareNext(first.id), /Could not return/);
  assert.equal(fixture.covered, false); await fixture.adapter.dispose(); assert.equal(fixture.disposed, true);
});

test('resource scheduler prioritizes foreground work and immediately drops cancelled pending jobs', async () => {
  const queue = new StageScheduler({ rpc: 1 }), order = []; let release;
  const running = queue.run('speech', 'a', () => new Promise(resolve => { release = resolve; }));
  await until(() => release);
  const controller = new AbortController();
  const background = queue.run('speech', 'b', async () => order.push('future'), { priority: 1 });
  const cancelled = queue.run('speech', 'c', async () => order.push('cancelled'), { signal: controller.signal }).catch(error => error);
  const foreground = queue.run('speech', 'd', async () => order.push('current'));
  controller.abort(); assert.equal((await cancelled).name, 'AbortError');
  release(); await Promise.all([running, background, foreground]);
  assert.deepEqual(order, ['current', 'future']);
});

class AudioFixture extends EventTarget {
  currentTime = 0;
  async play() { this.dispatchEvent(new Event('playing')); }
  pause() {}
  load() { this.currentTime = 0; }
  removeAttribute() {}
}
const settings = { provider: 'cartesia', voiceId: 'test', model: 'test', speed: 3, mode: 'stream' };

test('shared session queues real engine results and turns only after audio completes, preserving speed and avoiding regeneration', async () => {
  const fixture = pages(), host = new SourceHost(fixture.adapter), cache = new Map(); let calls = 0, session;
  const engine = new ReaderEngine({ audio: new AudioFixture(), cache: { get: async key => cache.get(key), set: async (key, value) => cache.set(key, value) },
    generate: async text => { calls++; return { pcm: new Uint8Array(480), duration: .01, words: [{ word: text, start: 0, end: .01 }] }; },
    onUpdate: state => session?.observe(state) });
  const transport = { request: message => message.type === 'source-next' ? host.prepareNext(message.after)
    : message.type === 'source-present' ? host.present(message.id) : host.cancel() };
  session = new ReadingSession({ engine, transport, createAudio: () => new AudioFixture() });
  session.load(await host.open(), settings); await session.play();
  await until(() => session.future.size === 2 && [...session.future.values()].every(record => record.ready));
  const before = calls; assert.equal(fixture.index, 0);
  await engine.next();
  await until(() => !session.pending);
  assert.equal(session.unit.id, 'page-1'); assert.equal(fixture.index, 1); assert.equal(engine.speed, 3);
  assert.equal(engine.state, 'playing'); assert.ok(engine.segments[0].result);
  assert.ok(calls <= before + 1); // At most the newly queued fourth page, not page 2 again.
  session.pause(); const unit = session.unit.id; await engine.next(); assert.equal(session.unit.id, unit);
  await session.stop(); assert.equal(session.future.size, 0); await host.dispose();
});

test('Stop during page presentation adopts the actual restored page without restarting audio', async () => {
  const fixture = pages(), host = new SourceHost(fixture.adapter); let session;
  const engine = new ReaderEngine({ audio: new AudioFixture(), cache: { get: async () => null, set: async () => {} },
    generate: async text => ({ pcm: new Uint8Array(480), duration: .01, words: [{ word: text, start: 0, end: .01 }] }),
    onUpdate: state => session?.observe(state) });
  const transport = { request: message => message.type === 'source-next' ? host.prepareNext(message.after)
    : message.type === 'source-present' ? host.present(message.id) : host.cancel() };
  session = new ReadingSession({ engine, transport, createAudio: () => new AudioFixture() });
  session.load(await host.open(), settings); await session.play();
  await until(() => session.future.size === 2 && !session.pending);
  const turn = fixture.access.turn; let release;
  fixture.access.turn = async direction => { await new Promise(resolve => { release = resolve; }); return turn(direction); };
  const advancing = engine.next(); await until(() => release);
  const stopping = session.stop(); release(); await Promise.all([advancing, stopping]);
  assert.equal(fixture.index, 1); assert.equal(session.unit.id, 'page-1');
  assert.equal(engine.state, 'idle'); assert.equal(engine.wantsPlay, false);
  assert.equal(session.future.size, 0); assert.equal(fixture.covered, false);
  await host.dispose();
});

test('Stop while Play waits for source cleanup prevents late playback', async () => {
  let release, calls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const unit = { id: 'current', blocks: ['current'], passages: [{ text: 'current', block: 0, offset: 0 }], source: { prefetch: true, pagination: true } };
  const engine = new ReaderEngine({ audio: new AudioFixture(), generate: async () => { calls++; }, cache: { get: async () => null } });
  const session = new ReadingSession({ engine, transport: { request: async () => { await gate; return unit; } } });
  session.load(unit, settings); const playing = session.play(), stopping = session.stop();
  release(); await Promise.all([playing, stopping]);
  assert.equal(calls, 0); assert.equal(engine.wantsPlay, false); assert.equal(session.wantsPlay, false);
});

test('a failed source preparation stops reading and requires reopening rather than resuming stale text', async () => {
  const errors = [], unit = { id: 'current', blocks: ['current'], passages: [{ text: 'current', block: 0, offset: 0 }], source: { prefetch: true, pagination: true } };
  const engine = new ReaderEngine({ audio: new AudioFixture(), generate: async () => ({ pcm: new Uint8Array(480), duration: .01 }),
    cache: { get: async () => null, set: async () => {} } });
  const session = new ReadingSession({ engine, onError: error => errors.push(error), transport: { request: async message => {
    if (message.type === 'source-next') throw new Error('Could not restore the source'); return unit;
  } } });
  session.load(unit, settings); await session.play(); await until(() => errors.length);
  assert.match(errors[0].message, /Could not restore/); assert.equal(engine.wantsPlay, false);
  await assert.rejects(session.play(), /Could not restore the source/); await session.stop();
});

test('reopening an externally changed page preserves play/pause, voice settings and current page audio', async () => {
  const unit = id => ({ id, blocks: [id], passages: [{ text: id, block: 0, offset: 0 }], source: { prefetch: true, pagination: true } });
  let actual = unit('first'), next = unit('second');
  const spoken = [], engine = new ReaderEngine({ audio: new AudioFixture(),
    cache: { get: async () => null, set: async () => {} },
    generate: async text => { spoken.push(text); return { pcm: new Uint8Array(480), duration: .01, words: [] }; } });
  const session = new ReadingSession({ engine, transport: { request: async message => {
    if (message.type === 'source-next') return [];
    if (message.type === 'source-refresh') actual = next;
    return actual;
  } } });
  session.load(actual, settings); await session.play(); await session.reopen();
  assert.equal(session.unit.id, 'second'); assert.equal(engine.wantsPlay, true); assert.equal(engine.speed, 3);
  assert.equal(engine.settings.voiceId, 'test'); assert.equal(spoken.at(-1), 'second');
  session.pause(); next = unit('third'); await session.reopen();
  assert.equal(session.unit.id, 'third'); assert.equal(engine.wantsPlay, false); assert.equal(session.needsRefresh, false);
  assert.equal(session.future.size, 0); await session.stop();
});

for (const action of ['stop', 'pause']) test(`${action} during page reopening prevents late playback and the next Play retries the current visible page`, async () => {
  const unit = id => ({ id, blocks: [id], passages: [{ text: id, block: 0, offset: 0 }], source: { prefetch: true, pagination: true } });
  let actual = unit('first'), release, refreshes = 0;
  const engine = new ReaderEngine({ audio: new AudioFixture(), cache: { get: async () => null, set: async () => {} },
    generate: async () => ({ pcm: new Uint8Array(480), duration: .01, words: [] }) });
  const session = new ReadingSession({ engine, transport: { request: async message => {
    if (message.type === 'source-next') return [];
    if (message.type === 'source-refresh') {
      if (++refreshes === 1) await new Promise(resolve => { release = resolve; });
      actual = unit('second');
    }
    return actual;
  } } });
  session.load(actual, settings); await session.play();
  const reopening = session.reopen(); await until(() => release);
  await session[action](); release(); await reopening;
  assert.equal(engine.wantsPlay, false); assert.equal(session.needsRefresh, true);
  await session.play();
  assert.equal(refreshes, 2); assert.equal(session.unit.id, 'second'); assert.equal(engine.wantsPlay, true);
  await session.stop();
});
