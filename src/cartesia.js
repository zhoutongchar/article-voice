import { parseVoice } from './voices.js';

export const API_BASE = 'https://api.cartesia.ai';
export const API_VERSION = '2026-08-14';
export const SAMPLE_RATE = 24000;

export function headers(key) {
  if (!key?.trim()) throw new Error('Add your Cartesia API key in Settings first.');
  return { Authorization: `Bearer ${key.trim()}`, 'Cartesia-Version': API_VERSION };
}

async function checkResponse(response) {
  if (response.ok) return response;
  // Never echo a provider response that might contain the request or credentials.
  const reasons = { 401: 'The Cartesia key was rejected.', 403: 'This key cannot access this resource.',
    402: 'Your Cartesia account needs credits.', 429: 'Cartesia is busy or your usage limit was reached. Try again shortly.' };
  throw new Error(reasons[response.status] || `Cartesia returned HTTP ${response.status}.`);
}

export async function listVoices(key, { query = '', cursor = '', gender = '', language = '', signal } = {}, fetcher = fetch) {
  const url = new URL(`${API_BASE}/voices`);
  url.searchParams.set('limit', '100');
  if (query) url.searchParams.set('q', query);
  if (cursor) url.searchParams.set('starting_after', cursor);
  if (gender) url.searchParams.set('gender', gender);
  if (language) url.searchParams.set('language', language);
  const response = await checkResponse(await fetcher(url, { headers: headers(key), signal }));
  const result = await response.json();
  if (!Array.isArray(result.data)) throw new Error('Cartesia returned an invalid voice list.');
  return { voices: result.data.map(parseVoice).filter(Boolean),
    cursor: result.has_more ? (result.next_page || result.data.at(-1)?.id) : null };
}

// SSE framing may be split anywhere, including inside a UTF-8 sequence or CRLF.
export async function* readSSE(body) {
  if (!body) throw new Error('Cartesia returned no audio stream.');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = '', lines = [];
  const parse = () => {
    const data = lines.filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
    lines = [];
    return data && data !== '[DONE]' ? JSON.parse(data) : null;
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      pending += done ? decoder.decode() : decoder.decode(value, { stream: true });
      // Leave a trailing CR until the next chunk so CRLF isn't counted twice.
      let match;
      while ((match = /\r\n|\n|\r(?!$)/.exec(pending))) {
        const line = pending.slice(0, match.index);
        pending = pending.slice(match.index + match[0].length);
        if (line) lines.push(line);
        else { const event = parse(); if (event) yield event; }
      }
      if (done) {
        if (pending.trim()) lines.push(pending.replace(/\r$/, ''));
        const event = parse(); if (event) yield event;
        break;
      }
      if (pending.length > 8_000_000) throw new Error('The audio stream contained an oversized event.');
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export function pcmWav(pcm, sampleRate = SAMPLE_RATE, metadata) {
  const encoder = new TextEncoder();
  const info = metadata ? encoder.encode(JSON.stringify(metadata)) : null;
  const extra = info ? 8 + info.length + info.length % 2 : 0;
  const buffer = new ArrayBuffer(44 + pcm.byteLength + extra);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const str = (offset, text) => bytes.set(encoder.encode(text), offset);
  str(0, 'RIFF'); view.setUint32(4, buffer.byteLength - 8, true); str(8, 'WAVE');
  str(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  str(36, 'data'); view.setUint32(40, pcm.byteLength, true); bytes.set(pcm, 44);
  if (info) { const offset = 44 + pcm.byteLength; str(offset, 'avtm'); view.setUint32(offset + 4, info.length, true); bytes.set(info, offset + 8); }
  return new Blob([buffer], { type: 'audio/wav' });
}

export async function synthesize(text, settings, signal, fetcher = fetch) {
  const response = await checkResponse(await fetcher(`${API_BASE}/tts/sse`, {
    method: 'POST', headers: { ...headers(settings.apiKey), 'Content-Type': 'application/json' }, signal,
    body: JSON.stringify({ model_id: settings.model || 'sonic-3.6', transcript: text,
      voice: settings.voiceId, ...(settings.language ? { language: settings.language } : {}),
      output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: SAMPLE_RATE },
      add_timestamps: true, use_normalized_timestamps: false, generation_config: { speed: 1 } })
  }));
  const pieces = [], words = [];
  let size = 0, complete = false;
  for await (const event of readSSE(response.body)) {
    if (event.type === 'error') throw new Error('Cartesia could not generate this passage. Check the voice, language and credits.');
    if (event.type === 'chunk') {
      if (typeof event.data !== 'string') throw new Error('Invalid Cartesia audio chunk.');
      const raw = atob(event.data);
      size += raw.length;
      if (size > 24_000_000) throw new Error('This passage exceeded the audio memory limit.');
      pieces.push(Uint8Array.from(raw, c => c.charCodeAt(0)));
    } else if (event.type === 'timestamps') {
      const t = event.word_timestamps;
      if (!t || !Array.isArray(t.words) || t.words.length !== t.start?.length || t.words.length !== t.end?.length)
        throw new Error('Cartesia returned invalid word timings.');
      t.words.forEach((word, i) => {
        if (typeof word !== 'string' || !Number.isFinite(t.start[i]) || !Number.isFinite(t.end[i]) || t.end[i] < t.start[i] || t.start[i] < 0)
          throw new Error('Cartesia returned invalid word timings.');
        words.push({ word, start: t.start[i], end: t.end[i] });
      });
    } else if (event.type === 'done') { complete = true; break; }
  }
  if (!complete || !size || size % 2) throw new Error('Cartesia audio was interrupted. Retry this passage.');
  const pcm = new Uint8Array(size);
  let offset = 0;
  for (const piece of pieces) { pcm.set(piece, offset); offset += piece.length; }
  return { pcm, words, duration: size / (SAMPLE_RATE * 2) };
}
