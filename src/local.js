import config from '../local/config.json' with { type: 'json' };
import { hasNative, nativeRequest } from './native.js';
import { isReferenceId } from './voices.js';
import { audioCache } from './cache.js';
import { identity, parseContent, parseSpeech, parseAudio, parseAlignment, projectPlayable, PipelineError } from './pipeline/contracts.js';
import { StageScheduler } from './pipeline/scheduler.js';
export const localScheduler = new StageScheduler({ rpc: 3, cpu: 2 });

export const LOCAL_CONFIG = config;

const BASE = `http://127.0.0.1:${config.port}`;
const unavailable = () => new Error('Start the local Qwen server with “npm run local” in the Article Voice folder, then connect again.');

async function request(path, options, fetcher) {
  let response;
  try { response = await fetcher(`${BASE}${path}`, options); }
  catch (error) { if (error.name === 'AbortError') throw error; throw unavailable(); }
  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    throw new PipelineError(detail?.code || (response.status === 429 ? 'QUEUE_FULL' : 'STAGE_FAILED'), detail?.error || (response.status === 409 ? 'The local voice reference changed. Connect the local server again in Settings.' : 'Local Qwen could not complete this request. Check its terminal.'), detail?.stage, !!detail?.retryable);
  }
  const value = await response.json();
  return value;
}

export async function localVoices(_key, { query = '', gender = '', language = '', signal } = {}, fetcher = fetch) {
  const value = hasNative() && fetcher === fetch
    ? await nativeRequest('voices', undefined, signal) : await request('/voices', { signal }, fetcher);
  validateIdentity(value);
  if (!Array.isArray(value.voices) || value.voices.some(voice => !isReferenceId(voice.referenceId)))
    throw new Error('Local voice references are not ready. Wait for the companion to finish starting.');
  // All nine speakers can read every supported language. Language metadata here
  // describes the native voice and must not hide other available speakers.
  return { voices: value.voices.filter(v => (!gender || v.gender === gender)
    && query.toLowerCase().split(/\s+/).every(term => `${v.name} ${v.description}`.toLowerCase().includes(term))), cursor: null };
}

async function stageRequest(method, payload, signal, settings, fetcher) {
  const scheduler = settings.scheduler || localScheduler;
  return scheduler.run(method, payload.content?.id || payload.speech?.id || '', async () => {
    const body = { ...payload, priority: settings.priority || 0 };
    const result = hasNative() && fetcher === fetch ? await nativeRequest(method, body, signal, progress => settings.onStage?.({ ...progress, stage: method, state: 'progress' }))
      : await request(`/pipeline/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal }, fetcher);
    if (result.schemaVersion !== 1 || result.stage !== method || !['completed', 'bypassed', 'rejected'].includes(result.status)
      || !Number.isFinite(result.elapsed) || result.elapsed < 0
      || JSON.stringify(result.inputIds) !== JSON.stringify(payload.audio ? [payload.speech.id, payload.audio.id] : [payload.content?.id || payload.speech?.id])) throw new PipelineError('INPUT_MISMATCH', 'A pipeline result belongs to different input.', method);
    settings.onStage?.({ stage: method, state: 'result', cached: !!result.cached, elapsed: result.elapsed, status: result.status });
    return result;
  }, { signal, priority: settings.priority || 0, onStage: settings.onStage });
}

export async function localFormatContent(content, context = {}, fetcher = fetch) {
  const settings = context, signal = context.signal;
  await parseContent(content);
  if (settings.improveText === false) return content;
  const result = await stageRequest('format', { content, enabled: true }, signal, settings, fetcher);
  const output = await parseContent(result.output);
  if (output.id !== content.id && !output.parentIds.includes(content.id)) throw new PipelineError('INPUT_MISMATCH', 'Formatted content lost its parent.', 'format');
  return output;
}

export async function localSynthesize(text, settings, signal, fetcher = fetch) {
  if (!isReferenceId(settings.voiceReferenceId)) throw new Error('Reconnect your voices in Settings to load the fixed voice reference.');
  const speech = await parseSpeech(settings.speechChunk), content = await parseContent(settings.sourceContent);
  if (speech.parentId !== content.id) throw new PipelineError('INPUT_MISMATCH', 'The speech content changed after planning.', 'synthesize');
  if (speech.text !== text) throw new PipelineError('INPUT_MISMATCH', 'The speech text changed after planning.', 'synthesize');
  const cache = settings.stageCache || audioCache;
  const audioKey = 'speech:' + await identity({ textDigest: speech.textDigest, referenceId: settings.voiceReferenceId,
    modelRevision: config.revision, generation: config.generation, language: settings.language || '', sampleRate: 24000 });
  const getAudio = async force => {
    let cached = force ? null : await cache.get(audioKey).catch(() => null);
    if (cached) {
      try { await parseAudio(cached.artifact, cached.pcm); } catch { cached = null; }
    }
    if (cached) { settings.onStage?.({ stage: 'synthesize', state: 'result', cached: true, elapsed: 0 }); return { ...cached, elapsed: 0 }; }
    const result = await stageRequest('synthesize', { speech, voice: settings.voiceId, language: settings.language || '', referenceId: settings.voiceReferenceId }, signal, settings, fetcher);
    if (typeof result.pcm !== 'string' || result.pcm.length > 32 * 1024 * 1024) throw new PipelineError('INVALID_ARTIFACT', 'Invalid speech audio.', 'synthesize');
    const pcm = Uint8Array.from(atob(result.pcm), char => char.charCodeAt(0)), artifact = await parseAudio(result.output, pcm);
    if (artifact.referenceId !== settings.voiceReferenceId || artifact.modelRevision !== config.revision || artifact.textDigest !== speech.textDigest) throw new PipelineError('INPUT_MISMATCH', 'The generated audio used different speech settings.', 'synthesize');
    const value = { artifact, pcm, elapsed: result.elapsed };
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    await cache.set(audioKey, value).catch(() => {}); return value;
  };
  let sound = await getAudio(false), timed, alignmentElapsed = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    const key = 'alignment:' + await identity({ audioId: sound.artifact.id, textDigest: speech.textDigest, alignerRevision: config.alignerRevision, language: settings.language || '' });
    const cached = await cache.get(key).catch(() => null);
    if (cached) {
      try { timed = await parseAlignment(cached.artifact, speech, sound.artifact); } catch { timed = null; }
    }
    if (timed) { settings.onStage?.({ stage: 'align', state: 'result', cached: true, elapsed: 0 }); break; }
    try {
      const result = await stageRequest('align', { speech, audio: sound.artifact, language: settings.language || '' }, signal, settings, fetcher);
      timed = await parseAlignment(result.output, speech, sound.artifact); alignmentElapsed = result.elapsed;
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      await cache.set(key, { artifact: timed }).catch(() => {}); break;
    } catch (error) {
      if (attempt || error.code !== 'ARTIFACT_EXPIRED') throw error;
      sound = await getAudio(true);
    }
  }
  const playable = await (settings.scheduler || localScheduler).run('project', speech.id, () => projectPlayable(content, speech, sound.artifact, timed),
    { signal, priority: settings.priority || 0, resource: 'cpu', onStage: settings.onStage });
  return { pcm: sound.pcm, duration: sound.artifact.frames / sound.artifact.sampleRate,
    words: timed.words.map((word, index) => ({ word: word.text, start: word.startSample / timed.sampleRate, end: word.endSample / timed.sampleRate,
      from: word.range?.start ?? null, to: word.range?.end ?? null, sourceRefs: playable.words[index].sources })), playable, audioArtifact: sound.artifact, alignment: timed,
    referenceId: sound.artifact.referenceId, timings: { speech: sound.elapsed || 0, align: alignmentElapsed } };
}

function validateIdentity(value) {
  if (value?.model !== config.model || value?.revision !== config.revision || value?.pipeline !== config.pipeline)
    throw new Error('Update Article Voice and its Chrome extension to the same version.');
}
