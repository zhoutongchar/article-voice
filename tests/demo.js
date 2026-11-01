import { mountReader } from '../src/content.js';
let reader, readerMode;
const output = document.getElementById('test-result');
function openReader(mode = 'fixture') {
  if (reader?.host.isConnected && readerMode === mode) return;
  reader?.cleanup(); readerMode = mode;
  reader = mountReader({ openFrame: `/player.html${mode === 'live' ? '?live=1' : mode === 'local' ? `?local=1${location.search.includes('app=1') ? '&app=1' : ''}` : ''}`,
    sendEvent: message => reader.frame.contentWindow.postMessage({ channel: 'article-voice-event', message }, location.origin),
    onRequest(handle, frame) {
    const listener = async event => {
      if (event.source !== frame.contentWindow || event.origin !== location.origin || event.data?.channel !== 'article-voice-test') return;
      try { event.source.postMessage({ id: event.data.id, ok: true, value: await handle(event.data.message) }, location.origin); }
      catch (error) { event.source.postMessage({ id: event.data.id, ok: false, error: error.message }, location.origin); }
    };
    window.addEventListener('message', listener);
    return () => window.removeEventListener('message', listener);
  } });
}
document.getElementById('open-reader').onclick = () => openReader();
document.getElementById('ux-tests').onclick = async () => {
  const button = document.getElementById('ux-tests'); button.disabled = true;
  const lines = [], pass = message => { lines.push(`PASS · ${message}`); output.textContent = lines.join('\n'); };
  try {
    reader?.cleanup(); reader = null; openReader();
    await waitFor(() => reader.frame.contentWindow.testPlayer?.engine.segments.length, 'Player did not initialize');
    const win = reader.frame.contentWindow, player = win.testPlayer, engine = player.engine;
    const $ = id => win.document.getElementById(id);
    if (player.getSettings().mode !== 'stream') throw new Error('Passage playback is not the default');
    if ($('provider') || $('model') || $('voice-gender') || $('voice-style') || win.document.querySelector('.provider')) throw new Error('Removed controls remain');
    pass('No model/provider choices, voice filters, or provider badge; passage playback is the default');
    $('play').click(); await waitFor(() => engine.state === 'playing' && engine.audio.currentTime > .1, 'Playback did not start');
    const startingTime = engine.audio.currentTime;
    for (const layout of ['minimal', 'compact', 'full']) {
      win.document.querySelector(`.view-switcher button[data-layout="${layout}"]`).click();
      await waitFor(() => player.getSettings().layout === layout && reader.host.style.width === (layout === 'minimal' ? '480px' : '408px'), 'View did not resize');
      const rect = $('follow').getBoundingClientRect();
      if (rect.width <= 0 || rect.bottom > reader.frame.clientHeight) throw new Error('Follow words is missing from ' + layout);
      if (layout === 'minimal' && reader.host.offsetHeight > 56) throw new Error('Minimal player is not a thin audio bar');
      const active = win.document.querySelector('.view-switcher button[aria-pressed="true"]');
      if (active?.dataset.layout !== layout) throw new Error('View buttons do not show the current view');
      if ($('layout')) throw new Error('View dropdown was not removed');
      if (layout === 'full' && $('settings').hidden) throw new Error('Full view lacks settings');
      if (!engine.wantsPlay || engine.audio.currentTime < startingTime) throw new Error('Changing view interrupted playback');
    }
    pass('Minimal, compact and full views resize, retain Follow words, and preserve playback');
    await waitFor(() => $('voice-results').textContent.startsWith('3 voices'), 'Voice choices missing');
    if (Array.from($('voice').options).filter(option => option.value).length !== 3) throw new Error('Voice list is incomplete');
    $('mode').value = 'ahead'; $('mode').dispatchEvent(new Event('change'));
    await waitFor(() => player.getSettings().mode === 'ahead', 'Whole-article mode was not saved');
    await engine.play();
    if (engine.state !== 'playing' || engine.segments.some(segment => !segment.result)) throw new Error('Whole-article mode started before all audio was ready');
    pass('Voice choices load; whole-article option prepares every passage before playback');
    engine.pause(); $('mode').value = 'stream'; $('mode').dispatchEvent(new Event('change'));
    await waitFor(() => player.getSettings().mode === 'stream', 'Passage mode was not restored');
    win.document.querySelector('.view-switcher button[data-layout="compact"]').click();
    const target = Math.floor(engine.segments.length * .75);
    await engine.go(target); await engine.play();
    await waitFor(() => window.scrollY > 300, 'Automatic following did not start');
    window.dispatchEvent(new WheelEvent('wheel', { deltaY: -500 })); window.scrollTo({ top: 0, behavior: 'instant' });
    await waitFor(() => !$('follow-status').hidden, 'Manual scroll pause was not shown');
    const started = performance.now();
    await new Promise(resolve => setTimeout(resolve, 1000));
    if (window.scrollY > 10 || !engine.wantsPlay || !CSS.highlights.has('article-voice-word') || !$('follow').checked) throw new Error(`Manual scroll: y=${window.scrollY.toFixed(0)}, playing=${engine.wantsPlay}, highlighted=${CSS.highlights.has('article-voice-word')}, follow=${$('follow').checked}`);
    await new Promise(resolve => setTimeout(resolve, 8000));
    if (window.scrollY > 10) throw new Error('Follow resumed before ten seconds');
    await waitFor(() => window.scrollY > 300 && $('follow-status').hidden, 'Follow did not automatically resume after ten seconds', 4000);
    const elapsed = performance.now() - started;
    if (elapsed < 9900) throw new Error('Scroll pause was shorter than ten seconds');
    engine.pause();
    pass(`Manual scroll holds the page for ten seconds (${(elapsed / 1000).toFixed(1)}s), keeps highlighting/audio, then resumes`);
    document.body.dataset.uxTestResult = 'passed'; pass('PLAYER UX CHECKS PASSED');
  } catch (error) { output.textContent = [...lines, `FAIL · ${error.message}`].join('\n'); document.body.dataset.uxTestResult = 'failed'; }
  finally { button.disabled = false; }
};
document.getElementById('interrupt-reader').onclick = async () => {
  if (!reader?.host.isConnected) openReader();
  reader.frame.setAttribute('srcdoc', '');
  await new Promise(resolve => setTimeout(resolve, 0));
  const notice = reader.host.shadowRoot.querySelector('[role="alert"]');
  if (!notice?.textContent.includes('End browser control') || CSS.highlights.has('article-voice-word')) {
    output.textContent = 'FAIL · interrupted reader did not explain the problem and clear source markers';
    return;
  }
  notice.querySelector('button').click();
  output.textContent = reader.host.isConnected ? 'FAIL · interrupted reader did not close' : 'PASS · interrupted frame shows recovery instructions, clears source markers, and closes cleanly';
};
document.getElementById('open-local-reader').onclick = () => {
  reader?.cleanup(); reader = null;
  document.getElementById('test-mode').textContent = 'Actual local Qwen3-TTS · fixed voice reference · no cloud API';
  output.textContent = 'Full article ready for local reading. Click a word or press Play; Settings offers nine fixed-reference voices.';
  openReader('local');
};
const waitFor = async (predicate, message, timeout = 15000) => {
  const until = performance.now() + timeout;
  while (performance.now() < until) { if (predicate()) return; await new Promise(r => setTimeout(r, 30)); }
  throw new Error(message);
};

function clickArticleWord(element, text, { select = false, ctrlKey = false, whitespace = false } = {}) {
  element.scrollIntoView({ block: 'center', behavior: 'instant' });
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let node, offset;
  while ((node = walker.nextNode())) { offset = node.data.indexOf(text); if (offset >= 0) break; }
  if (!node) throw new Error(`Test word not found: ${text}`);
  const range = document.createRange(); range.setStart(node, offset); range.setEnd(node, offset + text.length);
  if (select) { const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); }
  const rect = range.getClientRects()[0];
  const clientX = whitespace ? element.getBoundingClientRect().left - 20 : (rect.left + rect.right) / 2;
  const clientY = (rect.top + rect.bottom) / 2;
  const target = whitespace ? element : node.parentElement;
  if (!whitespace && document.elementFromPoint(clientX, clientY)?.closest('#test-tools')) throw new Error('The test panel covers the target word; use the responsive test layout.');
  target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX, clientY }));
  target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, clientX, clientY }));
  target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1, button: 0, clientX, clientY, ctrlKey }));
  return range;
}
document.getElementById('run-tests').onclick = async () => {
  const button = document.getElementById('run-tests'); button.disabled = true;
  const lines = [], pass = value => { lines.push(`PASS · ${value}`); output.textContent = lines.join('\n'); };
  try {
    document.getElementById('open-reader').click();
    await waitFor(() => reader.frame.contentWindow.testPlayer, 'Player did not initialize');
    const win = reader.frame.contentWindow, player = win.testPlayer, engine = player.engine;
    const $ = id => win.document.getElementById(id);
    await waitFor(() => engine.segments.length, 'Article extraction failed');
    if (engine.segments.some(s => /browser verification|Open reader/.test(s.text))) throw new Error('Navigation leaked into narration');
    pass(`Article extracted: ${engine.segments.length} passages; navigation excluded`);
    $('play').click();
    await waitFor(() => engine.audio.currentTime > 0.1 && engine.state === 'playing', 'Audio did not start');
    pass('Real HTML audio playback advances');
    await waitFor(() => CSS.highlights?.has('article-voice-word'), 'Spoken word not highlighted');
    const range = [...CSS.highlights.get('article-voice-word')][0];
    if (!range.toString().trim()) throw new Error('Empty word highlight');
    pass(`Original-page word highlighted: “${range.toString()}”`);
    if (!CSS.highlights.has('article-voice-passage')) throw new Error('Missing passage highlight');
    pass('Surrounding passage highlighted without replacing DOM');
    engine.pause();
    const first = engine.segments[0].result.words[0], second = engine.segments[0].result.words[1];
    engine.audio.currentTime = first.start + .01; engine.tick();
    await waitFor(() => CSS.highlights?.has('article-voice-word'), 'Initial word marker missing');
    const steadyPassage = CSS.highlights.get('article-voice-passage'), steadyRange = [...steadyPassage][0];
    const steadyWord = CSS.highlights.get('article-voice-word');
    engine.audio.currentTime = (first.end + second.start) / 2; engine.tick();
    await new Promise(r => setTimeout(r, 50));
    if (CSS.highlights.get('article-voice-passage') !== steadyPassage || [...steadyPassage][0] !== steadyRange
      || CSS.highlights.get('article-voice-word') !== steadyWord || !steadyWord.size)
      throw new Error('Highlight flashed during a word-timing gap');
    engine.audio.currentTime = second.start + .01; engine.tick();
    await new Promise(r => setTimeout(r, 50));
    if (CSS.highlights.get('article-voice-passage') !== steadyPassage || [...steadyPassage][0] !== steadyRange)
      throw new Error('Passage highlight was recreated between words');
    pass('Green passage stays steady and yellow marker holds through timing gaps');
    await engine.play();
    $('speed').value = '3'; $('speed').dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 200));
    const start = engine.audio.currentTime, wall = performance.now();
    await new Promise(r => setTimeout(r, 650));
    const rate = (engine.audio.currentTime - start) / ((performance.now() - wall) / 1000);
    if (Math.abs(rate - 3) > 0.5 || !engine.audio.preservesPitch) throw new Error(`Playback rate was ${rate.toFixed(2)} instead of 3`);
    pass(`3× playback measured at ${rate.toFixed(2)}×; pitch preservation enabled`);
    $('play').click(); await new Promise(r => setTimeout(r, 80));
    const paused = engine.audio.currentTime;
    await new Promise(r => setTimeout(r, 250));
    if (engine.state !== 'paused' || Math.abs(paused - engine.audio.currentTime) > 0.05) throw new Error('Pause did not hold position');
    pass('Pause holds audio position');
    // Check that speed changes reuse the generated audio.
    const calls = win.fixtureCalls;
    $('speed').value = '2'; $('speed').dispatchEvent(new Event('change'));
    $('play').click(); await waitFor(() => engine.state === 'playing', 'Resume failed');
    if (win.fixtureCalls !== calls) throw new Error('Speed change regenerated speech');
    pass('Resume and speed changes reuse existing speech');
    engine.pause();
    $('settings-toggle').click();
    await waitFor(() => $('voice-results').textContent.startsWith('3 voices'), 'Voice library did not load multiple choices');
    $('voice').value = 'recorded-daniel'; $('voice').dispatchEvent(new Event('change'));
    await waitFor(() => player.getSettings().voiceId === 'recorded-daniel', 'Voice choice was not saved');
    $('preview-voice').click();
    await waitFor(() => player.preview.state === 'playing' && player.preview.audio.currentTime > .1, 'Voice preview did not play');
    if (engine.wantsPlay) throw new Error('Article and preview played over each other');
    $('preview-voice').click();
    await waitFor(() => !player.preview.wantsPlay, 'Preview did not stop');
    $('voice').value = 'recorded-fixture'; $('voice').dispatchEvent(new Event('change'));
    await waitFor(() => player.getSettings().voiceId === 'recorded-fixture', 'Original voice was not restored');
    $('settings-toggle').click();
    pass('Voice choices, saved selection and audio preview work without filters');
    const paragraph = prefix => [...document.querySelectorAll('article p')].find(p => p.textContent.startsWith(prefix));
    const forward = paragraph('On the corner'), backward = paragraph('The first thing');
    $('speed').value = '3'; $('speed').dispatchEvent(new Event('change'));
    clickArticleWord(forward, 'pavement');
    await waitFor(() => engine.state === 'playing' && engine.lastWord === 'pavement', 'Click did not jump forward to the exact word');
    engine.pause();
    const forwardIndex = engine.index;
    if (engine.audio.currentTime < 1 || engine.speed !== 3) throw new Error('Word click started the passage at the wrong position or speed');
    pass('Clicking a later word seeks forward and starts at its timestamp at 3×');
    clickArticleWord(backward, 'kettle');
    await waitFor(() => engine.state === 'playing' && engine.lastWord === 'kettle', 'Click did not jump backward to the exact word');
    engine.pause();
    if (engine.index >= forwardIndex || engine.audio.currentTime < 1) throw new Error('Backward click did not seek within the earlier passage');
    pass('Clicking an earlier word jumps backward within its passage');
    const bold = document.querySelector('article strong');
    clickArticleWord(bold, 'next');
    await waitFor(() => engine.state === 'playing' && engine.lastWord === 'next', 'Inline formatted word could not be clicked');
    engine.pause();
    const selectedIndex = engine.index;
    clickArticleWord(backward, 'kettle', { select: true });
    await new Promise(r => setTimeout(r, 80));
    if (engine.wantsPlay || engine.index !== selectedIndex) throw new Error('Selecting text accidentally changed playback');
    window.getSelection().removeAllRanges();
    clickArticleWord(backward, 'kettle', { ctrlKey: true });
    clickArticleWord(backward, 'kettle', { whitespace: true });
    const link = document.querySelector('article a');
    link.addEventListener('click', event => event.preventDefault(), { once: true });
    clickArticleWord(link, 'curiosity');
    await new Promise(r => setTimeout(r, 80));
    if (engine.wantsPlay || engine.index !== selectedIndex || document.querySelector('article strong') !== bold || !link.href.includes('wikipedia.org'))
      throw new Error('Word navigation interfered with selection, links, formatting or modified clicks');
    pass('Formatted words are clickable; selection, links, whitespace and modified clicks keep normal behavior');
    const target = Math.floor(engine.segments.length * 0.75);
    window.scrollTo(0, 0);
    await engine.go(target); await engine.play();
    await waitFor(() => window.scrollY > 300 && CSS.highlights.has('article-voice-word'), 'Page did not follow later speech');
    pass(`Auto-scroll follows spoken words (${Math.round(window.scrollY)}px)`);
    engine.pause();
    $('follow').checked = false; $('follow').dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 80)); window.scrollTo(0, 0);
    await engine.go(target + 1); await engine.play();
    await new Promise(r => setTimeout(r, 350));
    if (window.scrollY > 10) throw new Error(`Follow toggle did not disable scrolling (scrollY=${Math.round(window.scrollY)})`);
    pass('Follow toggle stops automatic scrolling');
    engine.pause(); $('follow').checked = true; $('follow').dispatchEvent(new Event('change'));
    await engine.prepareAll();
    if (!engine.segments.every(s => s.result)) throw new Error('Full generation failed');
    const wav = await engine.exportWav(), view = new DataView(await wav.arrayBuffer());
    if (view.getUint32(0) !== 0x52494646 || wav.size < 44 || $('download').disabled) throw new Error('WAV export invalid');
    pass('Complete article generation and WAV export with word timings');
    const cacheCalls = win.fixtureCalls;
    engine.load(engine.article, player.getSettings());
    await engine.prepareAll();
    if (win.fixtureCalls !== cacheCalls) throw new Error('Saved audio was regenerated instead of read from IndexedDB');
    pass('New reading reuses the persistent browser audio cache');
    await engine.seek(engine.segments[0].result.duration + 0.4);
    if (engine.index !== 1 || Math.abs(engine.audio.currentTime - 0.4) > 0.1) throw new Error('Seeking failed');
    pass('Timeline seeking maps to the correct passage and audio position');
    await engine.openRecording(wav); await engine.play();
    await waitFor(() => engine.audio.currentTime > .1 && CSS.highlights.has('article-voice-word'), 'Saved WAV did not restore read-along');
    pass('Saved WAV reopens with audio and original-page word highlighting');
    engine.pause(); clickArticleWord(backward, 'kettle');
    await waitFor(() => engine.state === 'playing' && engine.lastWord === 'kettle', 'Click navigation did not work in the saved recording');
    engine.pause();
    if (engine.index !== 0 || engine.audio.currentTime < engine.segments[0].result.words.find(w => w.word === 'kettle').start)
      throw new Error('Saved recording click used passage-relative timing');
    pass('Click-to-word navigation works after reopening a saved WAV');
    engine.stop();
    await waitFor(() => !CSS.highlights.has('article-voice-word') && engine.audio.paused, 'Stop did not clean up');
    pass('Stop clears highlighting and audio');
    $('speed').value = '3'; $('speed').dispatchEvent(new Event('change'));
    await engine.seek(engine.segments[0].result.duration * 0.6); await engine.play();
    await waitFor(() => engine.state === 'playing', 'Final playback failed');
    document.body.dataset.testResult = 'passed'; pass('ALL BROWSER CHECKS PASSED · playing at 3×');
  } catch (error) { lines.push(`FAIL · ${error.message}`); output.textContent = lines.join('\n'); document.body.dataset.testResult = 'failed'; }
  finally { button.disabled = false; }
};

document.getElementById('live-tests').onclick = async () => {
  const button = document.getElementById('live-tests'); button.disabled = true;
  try {
    const config = await (await fetch('/test/config')).json();
    if (!config.liveAvailable) throw new Error('Live test needs CARTESIA_API_KEY in the project’s .env file. No key was found.');
    output.textContent = 'Generating one public article paragraph with Cartesia…';
    document.getElementById('test-mode').textContent = 'Live Cartesia · public test article · original word timestamps';
    openReader('live');
    await waitFor(() => reader.frame.contentWindow.testPlayer, 'Player did not initialize');
    const engine = reader.frame.contentWindow.testPlayer.engine;
    const index = engine.segments.findIndex(s => s.text.startsWith('The first thing'));
    if (index < 0) throw new Error('Public test paragraph not found');
    // One paragraph is enough to verify real service output at both speeds;
    // prevent the normal prefetch from generating the rest of the article.
    engine.segments = [engine.segments[index]];
    await engine.play();
    if (engine.state === 'error') throw new Error(engine.error);
    await waitFor(() => engine.audio.currentTime > .2 && CSS.highlights?.has('article-voice-word'), 'Live audio or word highlighting did not start', 30000);
    output.textContent = 'PASS · Cartesia SSE generated playable audio\nPASS · Original-page words follow provider timestamps\nTesting 3× playback…';
    engine.setSpeed(3);
    reader.frame.contentDocument.getElementById('speed').value = '3';
    await new Promise(r => setTimeout(r, 250));
    const start = engine.audio.currentTime, wall = performance.now();
    await new Promise(r => setTimeout(r, 650));
    const rate = (engine.audio.currentTime - start) / ((performance.now() - wall) / 1000);
    if (Math.abs(rate - 3) > .4 || !engine.audio.preservesPitch) throw new Error(`Live playback rate was ${rate.toFixed(2)}×`);
    output.textContent = `PASS · Real Cartesia audio played in Chrome\nPASS · Word highlighting follows original timestamps\nPASS · Auto-scroll to spoken paragraph\nPASS · 3× measured ${rate.toFixed(2)}×; pitch preservation enabled\nLIVE CARTESIA CHECKS PASSED`;
    document.body.dataset.liveTestResult = 'passed';
  } catch (error) { output.textContent = `LIVE TEST · ${error.message}`; document.body.dataset.liveTestResult = 'blocked'; }
  finally { button.disabled = false; }
};

document.getElementById('local-tests').onclick = async () => {
  const button = document.getElementById('local-tests'); button.disabled = true;
  const lines = [], pass = message => { lines.push(`PASS · ${message}`); output.textContent = lines.join('\n'); };
  try {
    document.getElementById('test-mode').textContent = 'Actual local Qwen3-TTS · measured word alignment · no cloud API';
    output.textContent = 'Generating the public article paragraph on this Mac…';
    openReader('local');
    await waitFor(() => reader.frame.contentWindow.testPlayer, 'Local player did not initialize');
    const win = reader.frame.contentWindow, player = win.testPlayer, engine = player.engine;
    const index = engine.segments.findIndex(s => s.text.startsWith('The first thing'));
    if (index < 0) throw new Error('Public test paragraph not found');
    const firstBlock = engine.segments[index].block;
    engine.segments = engine.segments.filter(segment => segment.block === firstBlock);
    await engine.play();
    if (engine.state === 'error') throw new Error(engine.error);
    await waitFor(() => engine.audio.currentTime > .15 && CSS.highlights.has('article-voice-word'), 'Local narration or highlight did not start', 30000);
    pass('Real Qwen speech plays in Chrome; no Cartesia key');
    await engine.fill(true);
    const words = engine.segments.flatMap(segment => segment.result.words);
    if (!words.some(word => word.word.toLowerCase() === 'kettle' && word.from != null)) throw new Error('Actual word alignment is missing');
    pass(`${words.length} words aligned to the generated paragraph audio`);
    engine.pause(); const paused = engine.audio.currentTime;
    await new Promise(r => setTimeout(r, 150));
    if (Math.abs(engine.audio.currentTime - paused) > .03) throw new Error('Pause did not hold position');
    pass('Pause holds the audio and word position');
    const paragraph = [...document.querySelectorAll('article p')].find(p => p.textContent.startsWith('The first thing'));
    clickArticleWord(paragraph, 'kettle');
    await waitFor(() => engine.state === 'playing' && engine.lastWord === 'kettle', 'Click did not seek to the actual aligned word');
    engine.pause(); pass(`Clicking kettle seeks to its measured time in its audio piece (${engine.audio.currentTime.toFixed(2)}s)`);
    clickArticleWord(paragraph, 'quiet');
    await waitFor(() => engine.state === 'playing' && engine.lastWord === 'quiet', 'Backward click did not seek');
    engine.pause(); pass(`Clicking quiet jumps back to its earlier audio piece (${engine.audio.currentTime.toFixed(2)}s)`);
    win.document.getElementById('speed').value = '3'; win.document.getElementById('speed').dispatchEvent(new Event('change'));
    await engine.seek(.2);
    await engine.play();
    await waitFor(() => !engine.audio.seeking, 'Audio seek did not settle');
    await new Promise(r => setTimeout(r, 150));
    const start = engine.audio.currentTime, wall = performance.now();
    await new Promise(r => setTimeout(r, 650));
    const rate = (engine.audio.currentTime - start) / ((performance.now() - wall) / 1000);
    if (Math.abs(rate - 3) > .4 || !engine.audio.preservesPitch) throw new Error(`Local speed was ${rate.toFixed(2)}× (audio ${start.toFixed(2)}–${engine.audio.currentTime.toFixed(2)}s, wall ${((performance.now()-wall)/1000).toFixed(2)}s)`);
    engine.pause(); pass(`3× playback measured ${rate.toFixed(2)}×; pitch preserved`);
    const article = engine.article, segment = engine.segments[0];
    // A new reading must work even with a provider that refuses generation.
    const generate = engine.generate; engine.generate = async () => { throw new Error('Cache miss: attempted another generation'); };
    try { engine.load(article, player.getSettings()); engine.segments = [{ text: segment.text, offset: segment.offset, block: segment.block }]; await engine.play(); }
    finally { engine.generate = generate; }
    if (engine.state !== 'playing') throw new Error(engine.error || 'Cache replay failed');
    engine.pause(); pass('Reopening the same paragraph uses persisted audio without regeneration');
    const referenceId = player.getSettings().voiceReferenceId;
    engine.load(article, player.getSettings());
    const paragraphBlocks = ['The first thing', 'We spend so much', 'There is a name'].map(prefix => article.passages.find(segment => segment.text.startsWith(prefix))?.block);
    if (paragraphBlocks.some(block => block == null)) throw new Error('Three public paragraphs were not found');
    engine.segments = article.passages.filter(segment => paragraphBlocks.includes(segment.block));
    await engine.prepareAll();
    if (engine.state === 'error') throw new Error(engine.error);
    if (!referenceId || engine.segments.some(segment => segment.result?.referenceId !== referenceId))
      throw new Error('Paragraphs did not use the same fixed voice reference');
    pass('Three real paragraphs use the exact same saved voice reference');
    await engine.play();
    await waitFor(() => engine.segments[engine.index]?.block === paragraphBlocks[1] && engine.state === 'playing', 'Second paragraph did not start automatically', 30000);
    await waitFor(() => CSS.highlights.get('article-voice-passage')?.values().next().value?.toString().startsWith('We spend'), 'Highlight did not follow the second paragraph');
    await waitFor(() => engine.segments[engine.index]?.block === paragraphBlocks[2] && engine.state === 'playing', 'Third paragraph did not start automatically', 30000);
    engine.pause(); pass('3× playback and page highlighting follow paragraph transitions');
    const $ = id => win.document.getElementById(id);
    $('settings-toggle').click();
    await waitFor(() => $('voice-results').textContent.startsWith('9 voices'), 'Local voice catalog did not load');
    pass('Nine local voice choices are available in Settings');
    if ($('provider') || $('model') || $('voice-gender') || $('voice-style')) throw new Error('Obsolete voice/model controls remain');
    if (player.getSettings().voiceReferenceId !== referenceId) throw new Error('Opening Settings changed the saved voice reference');
    pass('Simple voice settings preserve the exact narrator reference');
    $('settings-toggle').click();
    engine.segments = [engine.segments.find(segment => segment.text.startsWith('The first thing'))];
    await engine.play(); engine.pause();
    pass('LOCAL QWEN CHECKS PASSED'); document.body.dataset.localTestResult = 'passed';
  } catch (error) { output.textContent = [...lines, `FAIL · ${error.message}`].join('\n'); document.body.dataset.localTestResult = 'failed'; }
  finally { button.disabled = false; }
};
