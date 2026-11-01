import test from 'node:test';
import assert from 'node:assert/strict';
import { readSSE, pcmWav, synthesize, listVoices, API_VERSION } from '../src/cartesia.js';
import { alignWords, wordAtPosition } from '../src/alignment.js';
import { paragraphPassages, sentencePassages, PARAGRAPH_CHARACTERS } from '../src/article.js';
import { cacheKey } from '../src/cache.js';
import { readRecording } from '../src/recording.js';
import { parseVoice } from '../src/voices.js';

test('SSE accepts split UTF-8, CRLF, multiple events and an unterminated final event', async () => {
  const encoded = new TextEncoder().encode(': keepalive\r\ndata: {"type":"timestamps","word":"中文"}\r\n\r\ndata: {"type":"done"}');
  const stream = new ReadableStream({ start(controller) {
    for (let i = 0; i < encoded.length; i++) controller.enqueue(encoded.slice(i, i + 1));
    controller.close();
  } });
  const events = []; for await (const event of readSSE(stream)) events.push(event);
  assert.deepEqual(events, [{ type: 'timestamps', word: '中文' }, { type: 'done' }]);
});

test('source word alignment preserves offsets across punctuation, formatting text, ligatures and CJK', () => {
  const text = '“Hello,” café! 中文 ﬁne 2026.';
  const words = ['Hello', 'café', '中文', 'fine', '2026'].map((word, i) => ({ word, start: i, end: i + .8 }));
  const aligned = alignWords(text, words);
  assert.deepEqual(aligned.map(w => text.slice(w.from, w.to)), ['Hello', 'café', '中文', 'ﬁne', '2026']);
  assert.equal(wordAtPosition(aligned, 2.4).word, '中文');
  assert.equal(wordAtPosition(aligned, 2.9).word, '中文');
  assert.equal(wordAtPosition(aligned, 3).word, 'fine');
  assert.equal(wordAtPosition(aligned, -1), null);
});

test('unknown spoken normalization does not invent source coordinates or lose later words', () => {
  const aligned = alignWords('Pay $5 today.', [{ word: 'five', start: 0, end: .5 }, { word: 'today', start: .6, end: 1 }]);
  assert.equal(aligned[0].from, null);
  assert.equal(aligned[1].from, 7);
});

test('source offsets remain UTF-16 coordinates for emoji and letters outside the BMP', () => {
  const text = '😀 𐐀 hello';
  const aligned = alignWords(text, [{ word: '𐐀', start: 0, end: .5 }, { word: 'hello', start: .5, end: 1 }]);
  assert.deepEqual(aligned.map(word => text.slice(word.from, word.to)), ['𐐀', 'hello']);
});

test('long paragraphs split at sentence endings while preserving UTF-16 source offsets', () => {
  const text = '  First sentence. ' + 'A long linked sentence 😀 with some words. '.repeat(90) + '\nA visual line wrap stays here.\n\n A separate paragraph. ';
  const passages = paragraphPassages([{ text }, { text: '中文没有空格。也需要保持整个段落。' }]);
  assert.ok(passages.length > 3);
  assert.ok(passages.some(piece => piece.text.endsWith('A visual line wrap stays here.')));
  assert.ok(passages.every(piece => piece.text.length <= PARAGRAPH_CHARACTERS && /[.。]$/.test(piece.text)));
  assert.ok(paragraphPassages([{ text }], { splitLong: false })[0].text.length > 2500);
  for (const item of passages) {
    const original = item.block === 0 ? text : '中文没有空格。也需要保持整个段落。';
    assert.equal(original.slice(item.offset, item.offset + item.text.length), item.text);
  }
});

test('long-paragraph fallback never separates titles, decimals or a single overlong sentence', () => {
  const prefix = 'x'.repeat(1490) + '. ';
  const text = prefix + 'Dr. Mira kept the rate at 3.50%. Another complete sentence follows.';
  const pieces = sentencePassages(text);
  assert.deepEqual(pieces.map(piece => piece.text), [prefix.trim(), 'Dr. Mira kept the rate at 3.50%. Another complete sentence follows.']);
  const oneSentence = 'A sentence with many words ' + 'and more words '.repeat(130) + 'finally ends.';
  assert.deepEqual(sentencePassages(oneSentence), [{ text: oneSentence, offset: 0 }]);
  const normal = 'An ordinary paragraph. Its sentences stay together.';
  assert.deepEqual(sentencePassages(normal), [{ text: normal, offset: 0 }]);
  const cjk = '😀第一句保持完整。第二句也应完整！'.repeat(120);
  const chinese = sentencePassages(cjk);
  assert.ok(chinese.length > 1);
  for (const piece of chinese) {
    assert.equal(cjk.slice(piece.offset, piece.offset + piece.text.length), piece.text);
    assert.match(piece.text, /[。！]$/u);
    assert.ok(piece.text.length <= PARAGRAPH_CHARACTERS);
  }
});

test('WAV export records correct PCM size and embeds timing metadata', async () => {
  const pcm = new Uint8Array(48000);
  const metadata = { words: [{ word: 'hello', start: 0, end: 1 }] };
  const buffer = await pcmWav(pcm, 24000, metadata).arrayBuffer();
  const view = new DataView(buffer), bytes = new Uint8Array(buffer);
  assert.equal(new TextDecoder().decode(bytes.slice(0, 4)), 'RIFF');
  assert.equal(view.getUint32(4, true), bytes.length - 8);
  assert.equal(view.getUint32(24, true), 24000);
  assert.equal(view.getUint32(40, true), 48000);
  assert.equal(new TextDecoder().decode(bytes.slice(48044, 48048)), 'avtm');
  const length = view.getUint32(48048, true);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(bytes.slice(48052, 48052 + length))), metadata);
});

test('cache identity includes all synthesis choices and excludes playback speed and credentials', async () => {
  const base = { model: 'sonic-3.6', voiceId: 'voice1', language: 'en', speed: 1, apiKey: 'secret1' };
  const first = await cacheKey('hello', base);
  assert.equal(first, await cacheKey('hello', { ...base, speed: 3, apiKey: 'secret2' }));
  for (const change of [{ model: 'sonic-3.5' }, { voiceId: 'voice2' }, { language: 'zh' }])
    assert.notEqual(first, await cacheKey('hello', { ...base, ...change }));
  assert.notEqual(first, await cacheKey('hello!', base));
});

const streamResponse = events => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });
test('Cartesia request uses current API contract, normal generation speed, PCM and original word timestamps', async () => {
  const pcm = new Uint8Array(4800);
  const result = await synthesize('Hello', { apiKey: 'test-secret', model: 'sonic-3.6', voiceId: 'voice1', language: 'en', speed: 3 }, undefined,
    async (url, request) => {
      assert.equal(url, 'https://api.cartesia.ai/tts/sse');
      assert.equal(request.headers['Cartesia-Version'], API_VERSION);
      assert.equal(request.headers.Authorization, 'Bearer test-secret');
      const body = JSON.parse(request.body);
      assert.equal(body.voice, 'voice1'); assert.equal(body.generation_config.speed, 1);
      assert.equal(body.add_timestamps, true); assert.equal(body.use_normalized_timestamps, false);
      assert.deepEqual(body.output_format, { container: 'raw', encoding: 'pcm_s16le', sample_rate: 24000 });
      return streamResponse([{ type: 'chunk', data: Buffer.from(pcm).toString('base64') },
        { type: 'timestamps', word_timestamps: { words: ['Hello'], start: [0], end: [.1] } }, { type: 'done' }]);
    });
  assert.equal(result.duration, .1); assert.equal(result.words[0].word, 'Hello');
});

test('provider failures, truncated streams and malformed timestamp arrays stay explicit', async () => {
  const settings = { apiKey: 'test-secret', model: 'sonic-3.6', voiceId: 'voice' };
  await assert.rejects(synthesize('hello', settings, undefined, async () => new Response('', { status: 401 })), /key was rejected/);
  await assert.rejects(synthesize('hello', settings, undefined, async () => streamResponse([{ type: 'chunk', data: 'AAA=' }])), /interrupted/);
  await assert.rejects(synthesize('hello', settings, undefined, async () => streamResponse([{ type: 'timestamps', word_timestamps: { words: ['hello'], start: [], end: [1] } }])), /invalid word timings/);
  await assert.rejects(synthesize('hello', settings, undefined, async () => streamResponse([{ type: 'error', message: 'test-secret' }])), error => !error.message.includes('test-secret') && /could not generate/.test(error.message));
});

test('voice lookup preserves search and pagination cursor', async t => {
  t.mock.method(globalThis, 'fetch', async (url, request) => {
    assert.equal(url.searchParams.get('q'), 'warm voice');
    assert.equal(url.searchParams.get('starting_after'), 'voice1');
    assert.equal(url.searchParams.get('gender'), 'feminine');
    assert.equal(url.searchParams.get('language'), 'en');
    assert.equal(request.headers['Cartesia-Version'], API_VERSION);
    return Response.json({ data: [{ id: 'voice2', name: 'Voice Two' }], has_more: true, next_page: 'voice2' });
  });
  assert.deepEqual(await listVoices('test-secret', { query: 'warm voice', cursor: 'voice1', gender: 'feminine', language: 'en' }),
    { voices: [{ id: 'voice2', name: 'Voice Two' }], cursor: 'voice2' });
});

test('voice metadata preserves provider descriptions and omits unknown type and accent', () => {
  const voice = parseVoice({ id: 'voice', name: 'Test', gender: 'feminine', description: 'Calm narrator', language: 'en',
    accents: [null, { accent: 'general-american', is_native: true }, { accent: 5 }] });
  assert.equal(voice.description, 'Calm narrator'); assert.equal(voice.accents.length, 1);
  assert.deepEqual(parseVoice({ id: 'unknown', name: 'Saved voice' }), { id: 'unknown', name: 'Saved voice' });
  assert.equal(parseVoice(null), null);
});

test('saved WAV validates article identity and word coordinates before restoring', async () => {
  const article = { blocks: ['hello'] };
  const recording = pcmWav(new Uint8Array(48000), 24000, { version: 1, blocks: ['hello'], words: [{ word: 'hello', block: 0, start: 0, end: .8, from: 0, to: 5 }] });
  const read = await readRecording(recording, article);
  assert.equal(read.duration, 1); assert.equal(read.words[0].word, 'hello');
  await assert.rejects(readRecording(recording, { blocks: ['changed'] }), /different article text/);
  const malformed = pcmWav(new Uint8Array(48000), 24000, { version: 1, blocks: ['hello'], words: [{ word: 'hello', block: 0, start: -.2, end: .8, from: 0, to: 50 }] });
  await assert.rejects(readRecording(malformed, article), /invalid word timings/);
  await assert.rejects(readRecording(new Blob(['not a wav']), article), /Choose a WAV/);
});
