import { rangeFor, wordFromPoint } from '../src/article.js';
import { ReaderEngine } from '../src/engine.js';
import { preparedTextProjection } from '../src/prepared-text.js';

const $ = id => document.getElementById(id), output = $('checks');
const data = await (await fetch('/.cache/text-cleanup/report.json')).json();
let record, source, projection, mode, clicks = 0;
const clear = () => { CSS.highlights.delete('cleanup-word'); CSS.highlights.delete('cleanup-passage'); };
const decode = value => ({ ...value, pcm: Uint8Array.from(atob(value.pcm), char => char.charCodeAt(0)) });
const engine = new ReaderEngine({ audio: $('audio'), cache: { get: async () => null, set: async () => {} },
  generate: async () => decode(record[mode === 'prepared' ? 'preparedAudio' : 'originalAudio']),
  onUpdate: state => { $('status').textContent = `${mode === 'prepared' ? 'Prepared' : 'Original'} · ${state.state} · ${state.position.toFixed(1)}s · ${state.word || ''}`; },
  onHighlight: info => {
    clear(); if (!info || !$('follow').checked) return;
    CSS.highlights.set('cleanup-passage', new Highlight(rangeFor(source)));
    if (info.start == null) return;
    const span = mode === 'prepared' ? projection.source(info.start, info.end) : info;
    const range = span && rangeFor(source, span.start, span.end);
    if (range) CSS.highlights.set('cleanup-word', new Highlight(range));
  }
});
function select(index) {
  engine.stop(); record = data.reports[index]; projection = preparedTextProjection(record);
  $('source').textContent = record.original;
  const node = $('source').firstChild;
  source = { element: $('source'), text: record.original,
    points: Array.from({ length: record.original.length }, (_, offset) => ({ node, offset })) };
  $('before').textContent = 'Original: ' + record.original;
  $('after').textContent = 'Prepared: ' + record.text;
  $('details').textContent = `${data.model} · whole passage sent to LLM · ${record.status}${record.reason ? ' (' + record.reason + ')' : ''} · ${record.elapsed.toFixed(3)}s · real Qwen audio and forced alignment`;
  load('prepared');
}
function load(value) {
  mode = value;
  const text = value === 'prepared' ? record.text : record.original;
  engine.load({ title: 'HTML speech preparation', blocks: [text], passages: [{ text, block: 0, offset: 0 }] }, { speed: Number($('speed').value) });
}
async function play(value) { load(value); await engine.play(); }
data.reports.forEach((_, i) => { const option = document.createElement('option'); option.value = i; option.textContent = `Example ${i + 1}`; $('example').append(option); });
$('example').onchange = () => select(Number($('example').value));
$('original').onclick = () => play('original'); $('prepared').onclick = () => play('prepared');
$('pause').onclick = () => engine.pause(); $('stop').onclick = () => engine.stop();
$('speed').onchange = () => engine.setSpeed($('speed').value);
$('follow').onchange = () => { clear(); engine.lastHighlight = null; engine.tick(); };
$('source').onclick = async event => {
  const hit = wordFromPoint({ blocks: [source] }, event.clientX, event.clientY);
  if (!hit) return;
  const span = mode === 'prepared' ? projection.prepared(hit.start, hit.end) : hit;
  if (span) { clicks++; await engine.seekWord({ block: 0, ...span }); }
};
const wait = async (predicate, message, timeout = 10000) => {
  const until = performance.now() + timeout;
  while (performance.now() < until) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 30)); }
  throw new Error(message);
};
$('run-checks').onclick = async () => {
  $('run-checks').disabled = true; const lines = [];
  const pass = value => { lines.push('PASS · ' + value); output.textContent = lines.join('\n'); };
  try {
    select(0); await play('prepared');
    await wait(() => engine.state === 'playing' && engine.audio.currentTime > .15, 'Real Qwen audio did not play');
    pass('Prepared HTML text plays actual Qwen audio with measured aligner timestamps');
    engine.pause();
    const words = engine.segments[0].result.words;
    const changedWord = words.find(word => { const span = word.from != null && projection.source(word.from, word.to); return span && span.start !== word.from; });
    if (!changedWord) throw new Error('First example did not exercise shifted word coordinates');
    const originalSpan = projection.source(changedWord.from, changedWord.to);
    engine.audio.currentTime = changedWord.start; engine.lastHighlight = null; engine.tick();
    await wait(() => CSS.highlights.get('cleanup-word')?.size, 'Original word is not highlighted');
    const marked = [...CSS.highlights.get('cleanup-word')][0];
    if (marked.toString() !== record.original.slice(originalSpan.start, originalSpan.end)) throw new Error('Prepared speech highlighted the wrong source');
    pass('LLM edits shift speech offsets while highlighting stays on the original HTML word');
    const element = $('source'), glyph = rangeFor(source, originalSpan.start, originalSpan.end);
    const rect = glyph.getClientRects()[0]; const x = (rect.left + rect.right) / 2, y = (rect.top + rect.bottom) / 2;
    const before = clicks;
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x, clientY: y }));
    await wait(() => clicks > before && engine.state === 'playing', 'Clicking the original word did not seek and play');
    if (Math.abs(engine.audio.currentTime - changedWord.start) > .3) throw new Error('Original word sought to the wrong audio word');
    engine.pause(); pass('Clicking the original HTML word seeks to its prepared audio');
    $('speed').value = '3'; engine.setSpeed(3); await engine.play();
    const start = engine.audio.currentTime, wall = performance.now();
    await new Promise(resolve => setTimeout(resolve, 450));
    const rate = (engine.audio.currentTime - start) / ((performance.now() - wall) / 1000);
    if (Math.abs(rate - 3) > .5 || !engine.audio.preservesPitch) throw new Error('3× playback did not preserve rate and pitch setting');
    engine.pause(); pass(`3× playback measured at ${rate.toFixed(2)}× with pitch preservation`);
    const ordinary = words.at(-1);
    engine.audio.currentTime = ordinary.start; engine.lastHighlight = null; engine.tick();
    const plain = projection.source(ordinary.from, ordinary.to);
    if ([...CSS.highlights.get('cleanup-word')][0].toString() !== record.original.slice(plain.start, plain.end)) throw new Error('Prose highlight drifted after the expression');
    pass('Following prose retains its original word coordinates');
    for (const item of data.reports) {
      const map = preparedTextProjection(item);
      const actual = item.preparedAudio.preparation;
      if (!item.identity || !['formatted', 'unchanged', 'rejected'].includes(item.status)
        || actual?.identity !== item.identity || actual?.original !== item.original || actual?.text !== item.text)
        throw new Error('A passage skipped whole-passage LLM preparation');
      if (!map.source(0, item.text.length)) throw new Error('A prepared passage lost source coverage');
    }
    pass(`All ${data.reports.length} passages used the full LLM path, including clean text and unfamiliar formatting`);
    engine.stop(); if (CSS.highlights.has('cleanup-word')) throw new Error('Stop left a word highlighted');
    pass('Stop clears playback and marks'); document.body.dataset.cleanupResult = 'passed';
  } catch (error) { output.textContent = [...lines, 'FAIL · ' + error.message].join('\n'); document.body.dataset.cleanupResult = 'failed'; }
  finally { $('run-checks').disabled = false; }
};
select(0);
