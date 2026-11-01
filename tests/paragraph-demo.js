import { sourceSpan } from '../src/alignment.js';
import { mountReader } from '../src/content.js';
const output = document.getElementById('result');
let reader;
const long = new URL(location.href).searchParams.has('long');
if (long) {
  const paragraph = document.getElementById('paragraph');
  paragraph.textContent = [paragraph.textContent, paragraph.textContent, paragraph.textContent].join(' ');
  document.querySelector('h1').textContent = 'Long paragraphs, complete sentences';
}
const wait = async (predicate, message) => {
  const end = performance.now() + 120_000;
  while (performance.now() < end) {
    const engine = reader?.frame.contentWindow.testPlayer?.engine;
    if (engine?.error) throw new Error(engine.error);
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error(message);
};
document.getElementById('run').onclick = async event => {
  event.target.disabled = true;
  const results = [], pass = text => { results.push(`PASS · ${text}`); output.textContent = results.join('\n'); };
  try {
    reader = mountReader({ openFrame: `/player.html?local=1&app=1&fresh=1${new URL(location.href).searchParams.get('port') === '4326' ? '&port=4326' : ''}${new URL(location.href).searchParams.has('disable') ? '&disable=1' : ''}`,
      sendEvent: message => reader.frame.contentWindow.postMessage({ channel: 'article-voice-event', message }, location.origin),
      onRequest(handle, frame) {
        const listener = async event => {
          if (event.source !== frame.contentWindow || event.origin !== location.origin || event.data?.channel !== 'article-voice-test') return;
          try { event.source.postMessage({ id: event.data.id, ok: true, value: await handle(event.data.message) }, location.origin); }
          catch (error) { event.source.postMessage({ id: event.data.id, ok: false, error: error.message }, location.origin); }
        };
        window.addEventListener('message', listener); return () => window.removeEventListener('message', listener);
      } });
    await wait(() => reader.frame.contentWindow.testPlayer?.engine.article, 'Reader did not initialize');
    await reader.frame.contentWindow.testPlayer.engine.prepareSource();
    const win = reader.frame.contentWindow, { engine, session } = win.testPlayer;
    const expected = document.getElementById('paragraph').textContent;
    if (long) {
      const block = engine.article.blocks.indexOf(expected);
      await engine.ensure(engine.segments.findIndex(segment => segment.block === block));
      const pieces = engine.segments.filter(segment => segment.block === block);
      if (pieces.length < 2 || pieces.map(piece => piece.text).join(' ') !== expected) throw new Error('Long paragraph lost text or did not split');
      if (pieces.some(piece => !piece.text.endsWith('.'))) throw new Error('A request ended inside a sentence');
      pass(`The ${expected.length}-character paragraph splits into ${pieces.length} complete-sentence requests (${pieces.map(piece => piece.text.length).join(', ')} characters)`);
      const index = engine.segments.indexOf(pieces[0]);
      await engine.go(index); await session.play(); await engine.fill(true);
      const last = pieces[0].result.words.filter(word => word.from != null).at(-1);
      await session.seekWord(sourceSpan(pieces[0], last));
      await wait(() => engine.index === index + 1 && engine.state === 'playing', 'Audio did not advance at the sentence boundary');
      await wait(() => CSS.highlights.has('article-voice-word'), 'Following sentence lost its source highlight');
      const word = pieces[1].result.words.find(word => word.from != null);
      await session.seekWord(sourceSpan(pieces[1], word));
      if (Math.abs(engine.audio.currentTime - word.start) > .3) throw new Error('Word seeking lost the second piece offset');
      const calls = win.localCalls.filter(call => pieces.some(piece => piece.text === call.text));
      if (calls.length !== pieces.length) throw new Error('Speech requests were repeated or dropped');
      pass('Real Qwen playback advances at the complete-sentence boundary with prepared audio');
      pass('Source highlights and word seeking retain their offsets in the later speech piece');
      pass(`Actual speech durations: ${pieces.map(piece => piece.result.duration.toFixed(1) + 's').join(', ')}`);
      session.pause(); document.body.dataset.paragraphCheck = 'passed'; pass('LONG PARAGRAPH CHECK PASSED');
      return;
    }
    const index = engine.segments.findIndex(segment => segment.text === expected);
    if (index < 0 || expected.length < 480) throw new Error('The paragraph was split before speech');
    pass(`The ${expected.length}-character HTML paragraph is one speech request, including every sentence`);
    await engine.go(index); await session.play();
    await wait(() => engine.state === 'playing', 'Qwen playback did not start');
    const segment = engine.segments[index], words = segment.result.words;
    const plunging = words.find(word => word.word.toLowerCase() === 'plunging');
    const stock = words.find(word => word.word.toLowerCase() === 'stock');
    if (!plunging || !stock) throw new Error('Forced alignment lost the example phrase');
    const clip = engine.audio.src; let ended = 0;
    const onEnd = () => ended++;
    engine.audio.addEventListener('ended', onEnd);
    await session.seekWord({ block: segment.block, start: plunging.from, end: plunging.to });
    await wait(() => engine.audio.currentTime > stock.end + .4, 'Audio did not pass the phrase');
    engine.audio.removeEventListener('ended', onEnd);
    if (ended || engine.index !== index || engine.audio.src !== clip || engine.state !== 'playing') throw new Error('Playback restarted inside the paragraph');
    const calls = win.localCalls.filter(call => call.text === expected);
    if (calls.length !== 1) throw new Error('The paragraph was requested more than once');
    if (!CSS.highlights.has('article-voice-word')) throw new Error('Original-source word highlight is missing');
    pass('Played through “plunging stock” in the same audio clip, with no clip boundary or buffering transition');
    pass('Measured word seeking and original-page highlighting work inside the full paragraph');
    pass(`Actual synthesis: ${segment.result.duration.toFixed(1)}s audio; ${calls[0].timings.speech.toFixed(2)}s generation, ${calls[0].timings.align.toFixed(2)}s alignment`);
    session.pause();
    document.body.dataset.paragraphCheck = 'passed'; pass('PARAGRAPH PLAYBACK CHECK PASSED');
  } catch (error) {
    reader?.frame.contentWindow.testPlayer?.session.pause();
    document.body.dataset.paragraphCheck = 'failed'; output.textContent = [...results, `FAIL · ${error.message}`].join('\n');
  } finally { event.target.disabled = false; }
};
