import { startPlayer } from '../src/player.js';
import { synthesize, listVoices } from '../src/cartesia.js';
import { LOCAL_CONFIG, localSynthesize, localVoices, localPrepareText } from '../src/local.js';
import { prepareReadingUnit } from '../src/reading-preparation.js';
const managedApp = new URL(location.href).searchParams.has('app');
const testPort = new URL(location.href).searchParams.get('port') === '4326' ? '4326' : '4324';
const appFetch = (url, options) => fetch(String(url).replace('127.0.0.1:4318', `127.0.0.1:${testPort}`), options);
const live = new URL(location.href).searchParams.has('live');
const local = new URL(location.href).searchParams.has('local');
const config = live ? await (await fetch('/test/config')).json() : null;
const pending = new Map(); let sequence = 0, onReaderEvent;
window.addEventListener('message', event => {
  if (event.source !== parent || event.origin !== location.origin) return;
  if (event.data?.channel === 'article-voice-event') { onReaderEvent?.(event.data.message); return; }
  const request = pending.get(event.data?.id);
  if (request) { pending.delete(event.data.id); event.data.ok ? request.resolve(event.data.value) : request.reject(new Error(event.data.error)); }
});
const fixtureVoices = [
  { id: 'recorded-fixture', name: 'Samantha (recorded test)', gender: 'feminine', language: 'en', description: 'Warm, calm narration. Recorded test voice, not Cartesia.', accents: [{ accent: 'general-american', is_native: true }] },
  { id: 'recorded-daniel', name: 'Daniel (recorded test)', gender: 'masculine', language: 'en', description: 'Expressive, conversational narration. Recorded test voice, not Cartesia.', accents: [{ accent: 'british', is_native: true }] },
  { id: 'recorded-karen', name: 'Karen (recorded test)', gender: 'feminine', language: 'en', description: 'Warm, conversational voice. Recorded test voice, not Cartesia.', accents: [{ accent: 'australian', is_native: true }] }
];
let settings = { provider: 'cartesia', apiKey: 'recorded-fixture', voiceId: 'recorded-fixture', voiceName: fixtureVoices[0].name, voiceLibrary: fixtureVoices, model: 'sonic-3.6', speed: 1, follow: true, mode: 'stream' };
if (live) settings = { ...settings, apiKey: 'live-test-proxy', voiceId: config.voiceId, voiceName: 'Live Cartesia' };
if (local) settings = { provider: 'local', apiKey: '', voiceId: 'Ryan', voiceName: 'Ryan · local Qwen',
  voiceLibrary: LOCAL_CONFIG.voices, model: LOCAL_CONFIG.model, speed: 1, follow: true, mode: 'stream' };
const transport = {
  settings: async () => settings,
  save: async value => { settings = { ...settings, ...value }; },
  subscribe: async callback => { onReaderEvent = callback; return () => { onReaderEvent = null; }; },
  request: message => new Promise((resolve, reject) => {
    const id = ++sequence; pending.set(id, { resolve, reject });
    parent.postMessage({ channel: 'article-voice-test', id, message }, location.origin);
  })
};
window.fixtureCalls = 0;
const fixtureGenerate = async (text, settings, signal) => {
  window.fixtureCalls++;
  if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
  const file = { 'recorded-daniel': 'fixture-daniel.wav', 'recorded-karen': 'fixture-karen.wav' }[settings.voiceId] || 'fixture.wav';
  const response = await fetch(`/tests/${file}`, { signal });
  const bytes = new Uint8Array(await response.arrayBuffer());
  const view = new DataView(bytes.buffer);
  let cursor = 12, pcm;
  while (cursor + 8 <= bytes.length) {
    const name = new TextDecoder().decode(bytes.subarray(cursor, cursor + 4)), size = view.getUint32(cursor + 4, true);
    if (name === 'data') { pcm = bytes.slice(cursor + 8, cursor + 8 + size); break; }
    cursor += 8 + size + size % 2;
  }
  if (!pcm) throw new Error('Missing recorded audio fixture');
  const duration = pcm.length / 48000;
  const tokens = [...new Intl.Segmenter(undefined, { granularity: 'word' }).segment(text)].filter(t => t.isWordLike).map(t => t.segment);
  const words = tokens.map((word, i) => ({ word, start: duration * i / tokens.length, end: duration * (i + 0.9) / tokens.length }));
  return { pcm, duration, words };
};
// Deliberately separate from the shipping bundle: the fixture verifies browser
// transport/highlighting, not Cartesia pronunciation or timestamp accuracy.
const liveGenerate = (text, settings, signal) => synthesize(text, settings, signal,
  (_url, request) => fetch('/test/live-speech', { ...request, headers: { 'Content-Type': 'application/json' } }));
const fixtureVoiceList = async (_key, { query = '', gender = '', language = '' } = {}) => ({
  voices: fixtureVoices.filter(v => (!gender || v.gender === gender) && (!language || v.language === language)
    && query.toLowerCase().split(/\s+/).every(term => `${v.name} ${v.description}`.toLowerCase().includes(term))), cursor: null
});
const freshCache = new URL(location.href).searchParams.has('fresh') ? new Map() : null;
window.localCalls = [];
const appGenerate = async (text, settings, signal) => {
  const started = performance.now();
  const result = await localSynthesize(text, settings, signal, appFetch);
  window.localCalls.push({ text, preparation: result.preparation, timings: result.timings, wall: (performance.now() - started) / 1000 });
  return result;
};
window.testPlayer = await startPlayer({ transport, cache: freshCache ? { get: async key => freshCache.get(key), set: async (key, value) => freshCache.set(key, value), clear: async () => freshCache.clear() } : undefined,
  prepare: local && managedApp ? (unit, settings, signal) => prepareReadingUnit(unit, settings, signal, (text, signal) => localPrepareText(text, signal, appFetch)) : undefined,
  generate: local ? managedApp ? appGenerate : undefined : live ? liveGenerate : fixtureGenerate,
  loadVoices: local ? managedApp ? (key, options) => localVoices(key, options, appFetch) : undefined : live ? (key, options) => listVoices(key, options, (url, request) => fetch(`/test/live-voices${url.search}`, { signal: request.signal })) : fixtureVoiceList });
if (!live && !local) document.getElementById('voice-description').textContent = 'Recorded browser test voices. This fixture repeats sample audio; use the local reader for real narration.';
