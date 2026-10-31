import config from '../local/config.json' with { type: 'json' };

export const LOCAL_CONFIG = config;
export const isReferenceId = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const BASE = `http://127.0.0.1:${config.port}`;
const unavailable = () => new Error('Start the local Qwen server with “npm run local” in the Article Voice folder, then connect again.');

async function request(path, options, fetcher) {
  let response;
  try { response = await fetcher(`${BASE}${path}`, options); }
  catch (error) { if (error.name === 'AbortError') throw error; throw unavailable(); }
  if (!response.ok) throw new Error(response.status === 409 ? 'The local voice reference changed. Connect the local server again in Settings.'
    : response.status === 429 ? 'Local reader is busy. Try again shortly.' : 'Local Qwen could not complete this request. Check its terminal.');
  const value = await response.json();
  if (value.model !== config.model || value.revision !== config.revision || value.pipeline !== config.pipeline)
    throw new Error('The local server and extension versions differ. Restart the server and reload Article Voice.');
  return value;
}

export async function localVoices(_key, { query = '', gender = '', language = '', signal } = {}, fetcher = fetch) {
  const value = await request('/voices', { signal }, fetcher);
  if (!Array.isArray(value.voices) || value.voices.some(voice => !isReferenceId(voice.referenceId)))
    throw new Error('Local voice references are not ready. Wait for the companion to finish starting.');
  // All nine speakers can read every supported language. Language metadata here
  // describes the native voice and must not hide other available speakers.
  return { voices: value.voices.filter(v => (!gender || v.gender === gender)
    && query.toLowerCase().split(/\s+/).every(term => `${v.name} ${v.description}`.toLowerCase().includes(term))), cursor: null };
}

export async function localSynthesize(text, settings, signal, fetcher = fetch) {
  if (!isReferenceId(settings.voiceReferenceId)) throw new Error('Connect the local server in Settings to load its fixed voice reference.');
  const value = await request('/speech', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, voice: settings.voiceId, language: settings.language || '', referenceId: settings.voiceReferenceId }), signal }, fetcher);
  if (value.referenceId !== settings.voiceReferenceId) throw new Error('Local Qwen returned a different voice reference. Reconnect the local server.');
  if (value.sampleRate !== 24000 || typeof value.pcm !== 'string' || value.pcm.length > 32 * 1024 * 1024
    || !Array.isArray(value.words) || !value.words.length) throw new Error('Local Qwen returned invalid audio or missing word alignment.');
  const pcm = Uint8Array.from(atob(value.pcm), ch => ch.charCodeAt(0)), duration = pcm.byteLength / 48000;
  if (!pcm.byteLength || pcm.byteLength % 2 || Math.abs(value.duration - duration) > .01) throw new Error('Local Qwen returned invalid audio duration.');
  let previous = 0;
  for (const item of value.words) {
    if (typeof item.word !== 'string' || !Number.isFinite(item.start) || !Number.isFinite(item.end)
      || item.start < previous || item.end < item.start || item.end > duration + .01) throw new Error('Local Qwen returned invalid word timestamps.');
    previous = item.start;
  }
  return { pcm, duration, words: value.words, referenceId: value.referenceId };
}
