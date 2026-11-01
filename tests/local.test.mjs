import { digest } from '../src/hash.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { LOCAL_CONFIG, localSynthesize, localVoices } from '../src/local.js';
import { canGenerate, normalizeProviderSettings } from '../src/providers.js';
import { artifact, contentFromUnit, planSpeech } from '../src/pipeline/contracts.js';
import { cacheKey } from '../src/cache.js';

const referenceId = 'a'.repeat(64);
const identity = { model: LOCAL_CONFIG.model, revision: LOCAL_CONFIG.revision, pipeline: LOCAL_CONFIG.pipeline };
const settings = { provider: 'local', model: LOCAL_CONFIG.model, voiceId: 'Ryan', language: 'en', voiceReferenceId: referenceId };
const memory = () => { const values = new Map(); return { values, get: async key => values.get(key), set: async (key, value) => values.set(key, value) }; };
async function fixture() {
  const sourceContent = await contentFromUnit({ id: 'test', blocks: ['hello'] }), speech = (await planSpeech(sourceContent))[0], pcm = new Uint8Array(48000);
  const sound = await artifact('audio', { textDigest: speech.textDigest, format: 'pcm_s16le', sampleRate: 24000, channels: 1, frames: 24000,
    pcmDigest: await digest(pcm), voiceId: 'Ryan', referenceId, modelRevision: LOCAL_CONFIG.revision, generationId: 'b'.repeat(64) });
  const timing = await artifact('alignment', { audioId: sound.id, textDigest: speech.textDigest, sampleRate: 24000, frames: 24000,
    words: [{ text: 'hello', startSample: 2400, endSample: 19200, range: { start: 0, end: 5 } }], unmapped: [], alignerRevision: LOCAL_CONFIG.alignerRevision });
  const options = { ...settings, speechChunk: speech, sourceContent, stageCache: memory() }, calls = [];
  const fetcher = async (url, request) => {
    const body = JSON.parse(request.body); calls.push(url);
    assert.equal(body.speech.id, speech.id); assert.equal(request.body.includes('never-send-this'), false);
    const stage = url.endsWith('synthesize') ? 'synthesize' : 'align';
    return Response.json({ schemaVersion: 1, stage, status: 'completed', inputIds: stage === 'align' ? [speech.id, sound.id] : [speech.id],
      output: stage === 'align' ? timing : sound, ...(stage === 'synthesize' ? { pcm: btoa('\0'.repeat(48000)) } : {}), elapsed: .1 });
  };
  return { speech, sound, timing, options, fetcher, calls };
}

test('local speech uses independent synthesis/alignment contracts without API credentials', async () => {
  const { options, fetcher, calls } = await fixture();
  assert.ok(canGenerate(settings)); assert.equal(canGenerate({ ...settings, provider: 'cartesia' }), false);
  const result = await localSynthesize('hello', { ...options, apiKey: 'never-send-this' }, new AbortController().signal, fetcher);
  assert.deepEqual(calls.map(url => new URL(url).pathname), ['/pipeline/synthesize', '/pipeline/align']);
  assert.equal(result.pcm.length, 48000); assert.equal(result.words[0].start, .1); assert.equal(result.words[0].from, 0);
});

test('speech and alignment caches are independent and survive a different source parent', async () => {
  const { options, fetcher, calls } = await fixture();
  await localSynthesize('hello', options, undefined, fetcher);
  const sourceContent = await contentFromUnit({ id: 'another-page', blocks: ['hello'] }), speechChunk = (await planSpeech(sourceContent))[0];
  const reused = await localSynthesize('hello', { ...options, sourceContent, speechChunk }, undefined, fetcher);
  assert.equal(reused.playable.words[0].sources[0].unitId, 'another-page');
  assert.equal(calls.length, 2);
  for (const key of options.stageCache.values.keys()) if (key.startsWith('alignment:')) options.stageCache.values.delete(key);
  await localSynthesize('hello', options, undefined, fetcher);
  assert.equal(calls.filter(url => url.endsWith('synthesize')).length, 1);
  assert.equal(calls.filter(url => url.endsWith('align')).length, 2);
});

test('local stages reject changed artifacts, missing alignment and mismatched measured inputs', async () => {
  for (const change of [{ modelRevision: 'old' }, { referenceId: 'b'.repeat(64) }, { frames: 7 }, { textDigest: 'c'.repeat(64) }]) {
    const f = await fixture();
    await assert.rejects(localSynthesize('hello', f.options, undefined, async () => Response.json({ schemaVersion: 1, stage: 'synthesize', status: 'completed', inputIds: [f.speech.id],
      output: { ...f.sound, ...change }, pcm: btoa('\0'.repeat(48000)) })));
  }
  const f = await fixture();
  await assert.rejects(localSynthesize('hello', f.options, undefined, async () => { throw new TypeError('fetch failed'); }), /Start the local Qwen server/);
  await assert.rejects(localSynthesize('hello', f.options, undefined, async () => { throw new DOMException('Cancelled', 'AbortError'); }), { name: 'AbortError' });
  await assert.rejects(localSynthesize('hello', { ...f.options, voiceReferenceId: undefined }, undefined, () => assert.fail('Must not request speech')), /fixed voice reference/);
  await assert.rejects(localSynthesize('hello', f.options, undefined, async () => Response.json({ error: 'reference changed' }, { status: 409 })), /reference changed/);
  await assert.rejects(localSynthesize('hello', f.options, undefined, async () => Response.json({ error: 'This paragraph exceeds the local audio limit.' }, { status: 400 })), /paragraph exceeds/);
});

test('local voice metadata supports filters without hiding multilingual speakers by native language', async () => {
  const result = await localVoices('', { gender: 'masculine', query: 'sunny', language: 'zh' }, async () => Response.json({ ...identity, voices: LOCAL_CONFIG.voices.map(v => ({ ...v, referenceId })) }));
  assert.deepEqual(result.voices.map(v => v.id), ['Aiden']);
  assert.equal(result.voices[0].referenceId, referenceId);
  await assert.rejects(localVoices('', {}, async () => Response.json({ ...identity, voices: LOCAL_CONFIG.voices })), /references are not ready/);
});

test('local cache separates provider output and retains the same identity across credentials and speeds', async () => {
  const key = await cacheKey('hello', settings);
  assert.equal(key, await cacheKey('hello', { ...settings, speed: 3, apiKey: 'ignored' }));
  assert.notEqual(key, await cacheKey('hello', { ...settings, provider: 'cartesia' }));
  assert.notEqual(key, await cacheKey('hello', { ...settings, voiceId: 'Aiden' }));
  assert.notEqual(key, await cacheKey('hello', { ...settings, voiceReferenceId: 'b'.repeat(64) }));
  await assert.rejects(cacheKey('hello', { ...settings, voiceReferenceId: undefined }), /fixed voice reference/);
});

test('a removed provider restores the saved Qwen voice and requires current references before generation', () => {
  const restored = normalizeProviderSettings({ provider: 'retired-local', model: 'retired-model',
    voiceId: 'removed-voice', voiceLibrary: [{ id: 'removed-voice', referenceId }], language: 'en', apiKey: 'saved-cloud-key', speed: 3,
    providerProfiles: { local: { voiceId: 'Aiden' }, 'retired-local': { voiceId: 'removed-voice' } } });
  assert.equal(restored.provider, 'local');
  assert.equal(restored.model, LOCAL_CONFIG.model);
  assert.equal(restored.voiceId, 'Aiden');
  assert.equal(restored.speed, 3);
  assert.equal(restored.apiKey, 'saved-cloud-key');
  assert.deepEqual(restored.voiceLibrary, []);
  assert.deepEqual(Object.keys(restored.providerProfiles), ['local']);
  assert.equal(canGenerate(restored), false);
  const fresh = normalizeProviderSettings({ provider: 'retired-local', language: 'unsupported' });
  assert.equal(fresh.voiceId, 'Ryan');
  assert.equal(fresh.language, '');
});

test('supported provider selections stay unchanged while obsolete saved profiles are removed', () => {
  for (const provider of ['local', 'cartesia']) {
    const current = { ...settings, provider, apiKey: 'saved-cloud-key', providerProfiles: { local: { voiceId: 'Ryan' } } };
    assert.equal(normalizeProviderSettings(current), current);
    const retired = { ...current, providerProfiles: { ...current.providerProfiles, 'retired-local': { voiceId: 'removed-voice' } } };
    const restored = normalizeProviderSettings(retired);
    assert.deepEqual(restored, current);
  }
});
