import { textMap, rangeFor, wordFromPoint } from '../src/article.js';
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
  $('source').replaceChildren(); let cursor = 0;
  for (const item of record.decisions) {
    $('source').append(document.createTextNode(record.original.slice(cursor, item.start)));
    const span = document.createElement('span'); span.className = 'math'; span.dataset.math = '';
    const match = item.tex.match(/^([A-Za-z])_\{?([A-Za-z0-9])(?:\+([0-9]))?\}?$/);
    if (match) { const name = document.createElement('i'), sub = document.createElement('sub'); name.textContent = match[1]; sub.textContent = match[2] + (match[3] ? '+' + match[3] : ''); span.append(name, sub); }
    else span.textContent = item.original;
    $('source').append(span); cursor = item.end;
  }
  $('source').append(document.createTextNode(record.original.slice(cursor)));
  source = textMap($('source'));
  if (source.text !== record.original) throw new Error('Preview DOM and extracted source text disagree');
  $('before').textContent = 'Original: ' + record.original;
  $('after').textContent = 'Prepared: ' + record.text;
  $('details').textContent = `${data.model} · ${record.decisions.filter(x => x.accepted).length} verified expressions · prose preserved · real Qwen audio and forced alignment`;
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
    const expanded = record.spans.find(span => !span.identity);
    const words = engine.segments[0].result.words;
    const mathWord = words.find(word => word.from >= expanded.start && word.to <= expanded.end && /^sub/.test(word.word));
    if (!mathWord) throw new Error('Aligner did not time the spoken subscript');
    engine.audio.currentTime = mathWord.start; engine.lastHighlight = null; engine.tick();
    await wait(() => CSS.highlights.get('cleanup-word')?.size, 'Original expression is not highlighted');
    const marked = [...CSS.highlights.get('cleanup-word')][0];
    if (marked.toString() !== record.original.slice(expanded.from, expanded.to)) throw new Error('Spoken expansion highlighted the wrong source');
    pass('Spoken “subscript” highlights the original HTML expression rather than shifting later words');
    const element = $('source').querySelector('[data-math]');
    const glyph = document.createRange(), node = element.querySelector('i').firstChild;
    glyph.setStart(node, 0); glyph.setEnd(node, 1);
    const rect = glyph.getClientRects()[0]; const x = (rect.left + rect.right) / 2, y = (rect.top + rect.bottom) / 2;
    const before = clicks;
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x, clientY: y }));
    await wait(() => clicks > before && engine.state === 'playing', 'Clicking original math did not seek and play');
    const first = words.find(word => word.from >= expanded.start && word.from < expanded.end);
    if (Math.abs(engine.audio.currentTime - first.start) > .3) throw new Error('Original math sought to the wrong audio word');
    engine.pause(); pass('Clicking the original HTML expression seeks to its prepared audio');
    $('speed').value = '3'; engine.setSpeed(3); await engine.play();
    const start = engine.audio.currentTime, wall = performance.now();
    await new Promise(resolve => setTimeout(resolve, 450));
    const rate = (engine.audio.currentTime - start) / ((performance.now() - wall) / 1000);
    if (Math.abs(rate - 3) > .5 || !engine.audio.preservesPitch) throw new Error('3× playback did not preserve rate and pitch setting');
    engine.pause(); pass(`3× playback measured at ${rate.toFixed(2)}× with pitch preservation`);
    const ordinary = words.find(word => word.from > expanded.end + 1);
    engine.audio.currentTime = ordinary.start; engine.lastHighlight = null; engine.tick();
    const plain = projection.source(ordinary.from, ordinary.to);
    if ([...CSS.highlights.get('cleanup-word')][0].toString() !== record.original.slice(plain.start, plain.end)) throw new Error('Prose highlight drifted after the expression');
    pass('Following prose retains its original word coordinates');
    engine.stop(); if (CSS.highlights.has('cleanup-word')) throw new Error('Stop left a word highlighted');
    pass('Stop clears playback and marks'); document.body.dataset.cleanupResult = 'passed';
  } catch (error) { output.textContent = [...lines, 'FAIL · ' + error.message].join('\n'); document.body.dataset.cleanupResult = 'failed'; }
  finally { $('run-checks').disabled = false; }
};
select(0);
