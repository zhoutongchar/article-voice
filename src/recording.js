import { SAMPLE_RATE } from './cartesia.js';

export async function readRecording(blob, article) {
  if (blob.size > 160 * 1024 * 1024) throw new Error('This recording is too large to open.');
  const buffer = await blob.arrayBuffer(), view = new DataView(buffer), bytes = new Uint8Array(buffer);
  const text = (offset, size) => new TextDecoder().decode(bytes.subarray(offset, offset + size));
  if (bytes.length < 44 || text(0, 4) !== 'RIFF' || text(8, 4) !== 'WAVE') throw new Error('Choose a WAV saved by Article Voice.');
  let offset = 12, pcm, metadata, format = false;
  while (offset + 8 <= bytes.length) {
    const name = text(offset, 4), size = view.getUint32(offset + 4, true), start = offset + 8;
    if (size > bytes.length - start) throw new Error('The WAV recording is incomplete.');
    if (name === 'fmt ') {
      format = size >= 16 && view.getUint16(start, true) === 1 && view.getUint16(start + 2, true) === 1
        && view.getUint32(start + 4, true) === SAMPLE_RATE && view.getUint16(start + 14, true) === 16;
    } else if (name === 'data') pcm = bytes.slice(start, start + size);
    else if (name === 'avtm') {
      try { metadata = JSON.parse(text(start, size)); } catch { throw new Error('This recording has invalid word timings.'); }
    }
    offset = start + size + size % 2;
  }
  if (!format || !pcm?.length || pcm.length % 2 || metadata?.version !== 1 || !Array.isArray(metadata.words))
    throw new Error('Choose a WAV saved by Article Voice with word timings.');
  if (!Array.isArray(metadata.blocks) || metadata.blocks.length !== article.blocks.length || metadata.blocks.some((value, i) => value !== article.blocks[i]))
    throw new Error('This recording belongs to different article text. Open the original article first.');
  const duration = pcm.length / (SAMPLE_RATE * 2);
  let last = -1;
  for (const word of metadata.words) {
    if (!word || typeof word.word !== 'string' || !Number.isFinite(word.start) || !Number.isFinite(word.end)
      || word.start < 0 || word.start < last || word.end < word.start || word.end > duration + .25
      || !Number.isInteger(word.block) || word.block < 0 || word.block >= article.blocks.length
      || (word.from === null ? word.to !== null : (!Number.isInteger(word.from) || !Number.isInteger(word.to) || word.from < 0 || word.to <= word.from || word.to > article.blocks[word.block].length)))
      throw new Error('This recording has invalid word timings.');
    last = word.start;
  }
  return { pcm, words: metadata.words, duration };
}
