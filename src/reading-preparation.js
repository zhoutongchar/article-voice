import { localFormatContent } from './local.js';
import { alignWords } from './alignment.js';
import { contentChunksFromUnit, validateContentTransform, planSpeech, sourceRanges } from './pipeline/contracts.js';

// All sources share ContentChunk -> optional transform -> SpeechChunk. HTML
// placeholders are prepared lazily; OCR first seals its assembled page window.
export async function prepareReadingUnit(unit, settings, signal, format = localFormatContent) {
  if (settings.provider !== 'local') return unit;
  const inputs = await contentChunksFromUnit(unit);
  const fragmentRanges = refs => refs.flatMap(ref => {
    if (!unit.locations) return ref.unitId === (unit.id || 'preview') ? [{ block: ref.block, start: ref.start, end: ref.end }] : [];
    return unit.locations.flatMap((location, block) => {
      if (location.unit !== ref.unitId || location.block !== ref.block) return [];
      const start = Math.max(location.offset, ref.start), end = Math.min(location.offset + unit.blocks[block].length, ref.end);
      return end > start ? [{ block, start: start - location.offset, end: end - location.offset }] : [];
    });
  }).reduce((ranges, range) => {
    const last = ranges.at(-1);
    if (last?.block === range.block) { last.start = Math.min(last.start, range.start); last.end = Math.max(last.end, range.end); }
    else ranges.push(range);
    return ranges;
  }, []);
  const preparePassage = async (segment, currentSettings, currentSignal) => {
    const input = segment.contentInput;
    const content = currentSettings.improveText === false ? input : await format(input, { signal: currentSignal, priority: currentSettings.priority || 0, onStage: currentSettings.onStage, scheduler: currentSettings.scheduler });
    await validateContentTransform(input, content);
    if (currentSignal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    return (await planSpeech(content)).map(speech => {
      const ranges = fragmentRanges(sourceRanges(content, speech.range.start, speech.range.end));
      return { text: speech.text, speechChunk: speech, sourceContent: content, preparedOffset: speech.range.start,
        sourceRanges: ranges, block: ranges[0]?.block ?? 0, offset: ranges[0]?.start ?? 0 };
    });
  };
  let passages = inputs.map(contentInput => {
    const ranges = fragmentRanges(sourceRanges(contentInput, 0, contentInput.text.length));
    return { text: contentInput.text, contentInput, sourceRanges: ranges, block: ranges[0]?.block ?? 0, offset: ranges[0]?.start ?? 0 };
  });
  if (unit.source?.format === 'ocr') passages = (await Promise.all(passages.map(segment => preparePassage(segment, settings, signal)))).flat();
  return { ...unit, prepared: true, passages, preparePassage,
    align: (segment, words) => (words.every(word => Object.hasOwn(word, 'from')) ? words : alignWords(segment.text, words)).map(word => {
      const refs = word.sourceRefs || (word.from == null ? [] : sourceRanges(segment.sourceContent, segment.preparedOffset + word.from, segment.preparedOffset + word.to));
      const ranges = fragmentRanges(refs), primary = ranges.at(-1);
      return primary ? { ...word, block: primary.block, from: primary.start, to: primary.end,
        sources: ranges.map(range => ({ block: range.block, from: range.start, to: range.end })) } : { ...word, from: null, to: null };
    }) };
}
