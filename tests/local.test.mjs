import test from 'node:test';
import assert from 'node:assert/strict';
import { LOCAL_CONFIG, localSynthesize, localVoices } from '../src/local.js';
import { canGenerate, normalizeProviderSettings } from '../src/providers.js';
import { cacheKey } from '../src/cache.js';

const referenceId = 'a'.repeat(64);
const identity = { model: LOCAL_CONFIG.model, revision: LOCAL_CONFIG.revision, pipeline: LOCAL_CONFIG.pipeline };
const recording = () => ({ ...identity, sampleRate: 24000, pcm: btoa('\0'.repeat(48000)), duration: 1,
  referenceId, words: [{ word: 'hello', start: .1, end: .8 }] });
const settings = { provider: 'local', model: LOCAL_CONFIG.model, voiceId: 'Ryan', language: 'en', voiceReferenceId: referenceId };

test('local generation needs no API key and sends only a passage, voice and language to loopback', async () => {
  assert.ok(canGenerate(settings)); assert.equal(canGenerate({ ...settings, provider: 'cartesia' }), false);
  assert.equal(canGenerate({ ...settings, voiceReferenceId: undefined }), false);
  const signal = new AbortController().signal;
  const result = await localSynthesize('hello', { ...settings, apiKey: 'never-send-this' }, signal, async (url, request) => {
    assert.equal(url, 'http://127.0.0.1:4318/speech'); assert.equal(request.signal, signal);
    assert.deepEqual(JSON.parse(request.body), { text: 'hello', voice: 'Ryan', language: 'en', referenceId });
    assert.equal(JSON.stringify(request).includes('never-send-this'), false);
    return Response.json(recording());
  });
  assert.equal(result.pcm.length, 48000); assert.equal(result.words[0].start, .1);
});

test('local provider rejects stale model identity, missing alignment, malformed audio and invalid timing', async () => {
  for (const change of [{ revision: 'old' }, { referenceId: 'b'.repeat(64) }, { words: [] }, { duration: 7 }, { words: [{ word: 'hello', start: .8, end: .1 }] }])
    await assert.rejects(localSynthesize('hello', settings, undefined, async () => Response.json({ ...recording(), ...change })));
  await assert.rejects(localSynthesize('hello', settings, undefined, async () => { throw new TypeError('fetch failed'); }), /Start the local Qwen server/);
  await assert.rejects(localSynthesize('hello', settings, undefined, async () => { throw new DOMException('Cancelled', 'AbortError'); }), { name: 'AbortError' });
  await assert.rejects(localSynthesize('hello', { ...settings, voiceReferenceId: undefined }, undefined, () => assert.fail('Missing reference must not initiate inference')), /fixed voice reference/);
  await assert.rejects(localSynthesize('hello', settings, undefined, async () => new Response('', { status: 409 })), /reference changed/);
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
