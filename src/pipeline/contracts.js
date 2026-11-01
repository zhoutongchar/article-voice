import { digest } from '../hash.js';
import { paragraphPassages, sentencePassages } from '../text-segmentation.js';
import { preparedTextProjection } from '../prepared-text.js';
export const CONTRACT_VERSION = 1;
export class PipelineError extends Error {
  constructor(code, message, stage = 'contract', retryable = false) { super(message); this.code = code; this.stage = stage; this.retryable = retryable; }
}
const require = (condition, message = 'Invalid pipeline artifact') => { if (!condition) throw new PipelineError('INVALID_ARTIFACT', message); };
const integer = (value, minimum = 0) => Number.isInteger(value) && value >= minimum;
const hex = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const identity = value => digest(JSON.stringify(canonical(value)));
const freeze = value => { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
export async function artifact(kind, body) {
  const value = { schemaVersion: CONTRACT_VERSION, kind, ...body };
  return freeze({ id: await identity(value), ...value });
}
const span = (value, length, empty = false) => value && integer(value.start) && integer(value.end) && value.end <= length && (empty ? value.start <= value.end : value.start < value.end);
async function base(value, kind) {
  require(value?.schemaVersion === CONTRACT_VERSION && value.kind === kind && hex(value.id));
  const { id, ...body } = value; require(id === await identity(body), 'Pipeline artifact identity changed');
}
export async function parseContent(value) {
  await base(value, 'content');
  require(typeof value.text === 'string' && value.text.length > 0 && value.text.length <= 12000);
  require(['draft', 'sealed'].includes(value.stability) && typeof value.streamId === 'string' && integer(value.sequence));
  require(Array.isArray(value.parentIds) && value.parentIds.every(x => typeof x === 'string'));
  require(Array.isArray(value.paragraphs) && value.paragraphs.length > 0);
  let previous = 0;
  for (const item of value.paragraphs) { require(span(item, value.text.length) && item.start >= previous); previous = item.end; }
  require(Array.isArray(value.sourceMap)); previous = 0;
  for (const item of value.sourceMap) {
    require(span(item, value.text.length) && item.start === previous && typeof item.identity === 'boolean' && Array.isArray(item.sources));
    for (const ref of item.sources) require(typeof ref.unitId === 'string' && typeof ref.revision === 'string' && integer(ref.block) && integer(ref.start) && integer(ref.end, 1) && ref.end > ref.start);
    require(!item.identity || item.sources.length === 1 && item.end - item.start === item.sources[0].end - item.sources[0].start);
    previous = item.end;
  }
  require(previous === value.text.length, 'Incomplete content source mapping'); return freeze(value);
}
export async function parseSpeech(value) {
  await base(value, 'speech');
  require(hex(value.parentId) && integer(value.sequence) && typeof value.policy === 'string');
  require(typeof value.text === 'string' && value.text.length > 0 && value.text.length <= 12000 && value.textDigest === await digest(value.text));
  require(span(value.range, 12000) && value.range.end - value.range.start === value.text.length); return freeze(value);
}
export async function parseAudio(value, pcm) {
  await base(value, 'audio');
  require(value.format === 'pcm_s16le' && value.sampleRate === 24000 && value.channels === 1 && integer(value.frames, 1));
  require(['textDigest', 'pcmDigest', 'referenceId', 'generationId'].every(key => hex(value[key])) && typeof value.modelRevision === 'string' && typeof value.voiceId === 'string');
  if (pcm) require(pcm.byteLength === value.frames * 2 && await digest(pcm) === value.pcmDigest, 'Audio bytes do not match their artifact');
  return freeze(value);
}
export async function parseAlignment(value, speech, audio) {
  await base(value, 'alignment'); await parseSpeech(speech); await parseAudio(audio);
  require(value.audioId === audio.id && value.textDigest === speech.textDigest && value.textDigest === audio.textDigest, 'Alignment belongs to different text or audio');
  require(value.sampleRate === audio.sampleRate && value.frames === audio.frames && typeof value.alignerRevision === 'string');
  require(Array.isArray(value.words) && value.words.length > 0); let previous = 0;
  for (const word of value.words) {
    require(typeof word.text === 'string' && span({ start: word.startSample, end: word.endSample }, audio.frames, true) && word.startSample >= previous);
    require(word.range === null || span(word.range, speech.text.length)); previous = word.startSample;
  }
  require(Array.isArray(value.unmapped) && value.unmapped.every(item => span(item, speech.text.length))); return freeze(value);
}
export function sourceRanges(chunk, start, end) {
  const refs = [];
  for (const item of chunk.sourceMap) {
    if (start >= item.end || end <= item.start) continue;
    for (const source of item.sources) {
      const ref = { ...source };
      if (item.identity) { ref.start += Math.max(start, item.start) - item.start; ref.end = source.start + Math.min(end, item.end) - item.start; }
      const last = refs.at(-1);
      if (last && ['unitId', 'revision', 'block'].every(key => last[key] === ref[key]) && ref.start <= last.end) last.end = Math.max(last.end, ref.end);
      else refs.push(ref);
    }
  }
  return refs;
}
export async function contentFromUnit(unit) {
  if (unit.content && !unit.locations) return parseContent(unit.content);
  let text = ''; const sourceMap = [];
  for (const [block, value] of unit.blocks.entries()) {
    const separator = block ? unit.separators?.[block - 1] ?? '\n\n' : '';
    if (separator) { sourceMap.push({ start: text.length, end: text.length + separator.length, identity: false, sources: [] }); text += separator; }
    const location = unit.locations?.[block] || { unit: unit.id || 'preview', block, offset: 0 };
    if (value) sourceMap.push({ start: text.length, end: text.length + value.length, identity: true,
      sources: [{ unitId: location.unit, revision: location.unit, block: location.block, start: location.offset, end: location.offset + value.length }] });
    text += value;
  }
  return parseContent(await artifact('content', { parentIds: unit.parentIds || [], streamId: unit.streamId || unit.content?.streamId || unit.url || unit.id || 'preview',
    sequence: unit.sequence ?? unit.content?.sequence ?? 0, stability: unit.stability || 'sealed', text,
    paragraphs: paragraphPassages([{ text }], { splitLong: false }).map(p => ({ start: p.offset, end: p.offset + p.text.length })), sourceMap }));
}
export async function transformContent(chunk, record) {
  await parseContent(chunk); require(record.original === chunk.text);
  if (record.text === chunk.text) return chunk;
  const projection = preparedTextProjection(record), sourceMap = [];
  for (const item of record.spans) {
    if (item.start === item.end) continue;
    if (item.identity) {
      for (const old of chunk.sourceMap) {
        const start = Math.max(old.start, item.from), end = Math.min(old.end, item.to);
        if (end <= start) continue;
        sourceMap.push({ start: item.start + start - item.from, end: item.start + end - item.from, identity: old.identity, sources: sourceRanges(chunk, start, end) });
      }
    } else sourceMap.push({ start: item.start, end: item.end, identity: false, sources: sourceRanges(chunk, item.from, item.to) });
  }
  const paragraphs = chunk.paragraphs.map(p => { const range = projection.prepared(p.start, p.end); require(range, 'A formatted paragraph lost its source text'); return range; });
  return parseContent(await artifact('content', { parentIds: [chunk.id], streamId: chunk.streamId, sequence: chunk.sequence,
    stability: chunk.stability, text: record.text, paragraphs, sourceMap }));
}
export async function planSpeech(chunk) {
  await parseContent(chunk); require(chunk.stability === 'sealed', 'Only sealed content can enter speech');
  const result = [];
  for (const paragraph of chunk.paragraphs) {
    const raw = chunk.text.slice(paragraph.start, paragraph.end), text = raw.trim(), offset = paragraph.start + raw.indexOf(text);
    for (const piece of sentencePassages(text)) result.push(await artifact('speech', { parentId: chunk.id, sequence: result.length,
      text: piece.text, textDigest: await digest(piece.text), range: { start: offset + piece.offset, end: offset + piece.offset + piece.text.length }, policy: 'paragraph-sentence-1500-v1' }));
  }
  return result;
}

export async function contentChunksFromUnit(unit) {
  // HTML can contain an entire long article. Capture paragraph-sized content
  // artifacts so formatting remains lazy; OCR keeps its assembled window.
  if (unit.contentChunks && !unit.locations) return Promise.all(unit.contentChunks.map(parseContent));
  if (unit.source?.format === 'ocr' || unit.locations) return [await contentFromUnit(unit)];
  const result = [];
  for (const [block, text] of unit.blocks.entries()) {
    for (const paragraph of paragraphPassages([{ text }], { splitLong: false })) {
      const pieces = paragraph.text.length > 12000 ? sentencePassages(paragraph.text) : [{ text: paragraph.text, offset: 0 }];
      for (const piece of pieces) {
        const offset = paragraph.offset + piece.offset, location = { unit: unit.id || 'preview', block, offset };
        result.push(await contentFromUnit({ ...unit, content: undefined, contentChunks: undefined, blocks: [piece.text], locations: [location], source: { format: 'ocr' }, sequence: (unit.sequence || 0) + result.length }));
      }
    }
  }
  return result;
}

export async function projectPlayable(content, speech, audio, alignment) {
  await parseContent(content); await parseAlignment(alignment, speech, audio);
  require(speech.parentId === content.id && content.text.slice(speech.range.start, speech.range.end) === speech.text, 'Speech belongs to different content');
  return artifact('playable', { contentId: content.id, speechId: speech.id, audioId: audio.id, alignmentId: alignment.id,
    sampleRate: audio.sampleRate, frames: audio.frames,
    words: alignment.words.map(word => ({ text: word.text, startSample: word.startSample, endSample: word.endSample,
      sources: word.range ? sourceRanges(content, speech.range.start + word.range.start, speech.range.start + word.range.end) : [] })) });
}

export async function validateContentTransform(input, output) {
  await parseContent(input); await parseContent(output);
  if (input.id === output.id) return output;
  require(output.parentIds.includes(input.id) && output.streamId === input.streamId && output.sequence === input.sequence && output.stability === input.stability,
    'Formatting changed content ownership or order');
  for (const item of output.sourceMap) for (const ref of item.sources) {
    const origins = input.sourceMap.flatMap(span => span.sources).filter(source => source.unitId === ref.unitId && source.revision === ref.revision && source.block === ref.block);
    require(origins.length && ref.start >= Math.min(...origins.map(source => source.start)) && ref.end <= Math.max(...origins.map(source => source.end)),
      'Formatting invented a source reference');
  }
  return output;
}
