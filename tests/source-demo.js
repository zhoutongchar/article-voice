import { mountReader } from '../src/content.js';
import { createKindleSource } from '../src/sources/kindle.js';

const pages = [
  ['A quiet room waits at the end of the street.', 'Morning light moves across the table. There is time to notice it.'],
  ['A bicycle passes the window. Someone waves hello.', 'The garden gate is open, and the path leads between the trees.'],
  ['Paper lanterns move in the afternoon breeze.', 'A familiar voice turns another page. The story keeps its gentle rhythm.'],
  ['The kettle begins to sing in the kitchen.', 'We put our books on the table and listen to the rain.'],
  ['Evening arrives with warm windows and quiet streets.', 'There is another story waiting, whenever we are ready.']
];
let index = 0, reader, adapter, layoutScale = 1;
const output = document.getElementById('result');
let labelTimer, navigationBusy = false, refusedTurns = 0, heldRecognition;
async function render(scale = layoutScale) {
  layoutScale = scale;
  clearTimeout(labelTimer);
  const canvas = document.createElement('canvas'); canvas.width = 1600 * scale; canvas.height = 1000 * scale;
  const ctx = canvas.getContext('2d'); ctx.scale(scale, scale); ctx.fillStyle = '#faf9f5'; ctx.fillRect(0, 0, 1600, 1000);
  ctx.fillStyle = '#172f24'; ctx.font = '48px Georgia';
  let y = 180;
  for (const paragraph of pages[index]) {
    let line = '';
    for (const word of paragraph.split(' ')) {
      const next = line ? `${line} ${word}` : word;
      if (ctx.measureText(next).width > 1350) { ctx.fillText(line, 100, y); y += 76; line = word; }
      else line = next;
    }
    ctx.fillText(line, 100, y); y += 160;
  }
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
  const previousImage = document.querySelector('#kr-renderer img'), previous = previousImage.src;
  const image = previousImage.cloneNode(); previousImage.replaceWith(image);
  image.src = URL.createObjectURL(blob); await image.decode();
  // The production Kindle renderer revokes decoded image URLs immediately.
  URL.revokeObjectURL(image.src);
  if (previous.startsWith('blob:')) URL.revokeObjectURL(previous);
  const location = document.getElementById('kr-scrubber-bar'); location.textContent = `Page ${index + 1}`;
  // Kindle's optional location label can disappear or lag the image. Keep it
  // absent through capture, then recreate it before the next navigation.
  if (index % 2) {
    location.removeAttribute('aria-label');
    labelTimer = setTimeout(() => location.setAttribute('aria-label', `Page ${index + 1}`), 250);
  } else location.setAttribute('aria-label', `Page ${index + 1}`);
  document.getElementById('kr-chevron-left').disabled = index === 0;
  document.getElementById('kr-chevron-right').disabled = index === pages.length - 1;
  document.body.dataset.page = String(index);
}
// Match Kindle's delivered gesture boundary: navigation belongs to the
// surrounding container's press/release handler, not a button click handler.
const bindPageTurn = (id, direction) => {
  const button = document.getElementById(id), container = button.parentElement;
  container.addEventListener('mousedown', event => {
    if (button.disabled || event.button !== 0) return;
    if (navigationBusy) { refusedTurns++; return; }
    event.stopPropagation();
    const release = event => {
      container.removeEventListener('mouseup', release);
      event.stopPropagation(); event.preventDefault();
      if (index + direction >= 0 && index + direction < pages.length) {
        navigationBusy = true;
        const loader = document.querySelector('.loader'); loader.append(document.createElement('span'));
        index += direction;
        render().then(() => setTimeout(() => { navigationBusy = false; loader.replaceChildren(); }, 300));
      }
    };
    container.addEventListener('mouseup', release, { once: true });
  });
};
bindPageTurn('kr-chevron-left', -1); bindPageTurn('kr-chevron-right', 1);
await render();
const recognize = async (image, signal) => {
  if (heldRecognition) {
    const gate = heldRecognition; heldRecognition = null;
    await new Promise((resolve, reject) => {
      const abort = () => { signal.removeEventListener('abort', abort); reject(new DOMException('Cancelled', 'AbortError')); };
      gate.release = () => { signal.removeEventListener('abort', abort); resolve(); };
      signal.addEventListener('abort', abort, { once: true }); gate.started = true;
      if (signal.aborted) abort();
    });
  }
  const response = await fetch('/test/ocr', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image, language: 'en' }), signal });
  const value = await response.json(); if (value.error) throw new Error(value.error); return value;
};
async function openReader() {
  if (reader?.host.isConnected) return;
  const local = new URL(location.href).searchParams.has('local');
  if (local) document.getElementById('mode').textContent = 'Actual Apple Vision OCR and real local Qwen through the app-managed speech engine.';
  reader = mountReader({ createAdapter: context => adapter = createKindleSource({ ...context,
    url: new URL('https://read.amazon.com/?asin=public-test-book'), recognize }),
    openFrame: `/player.html${local ? `?local=1&app=1${new URL(location.href).searchParams.has('fresh') ? '&fresh=1' : ''}` : ''}`,
    sendEvent: message => reader.frame.contentWindow.postMessage({ channel: 'article-voice-event', message }, location.origin),
    onRequest(handle, frame) {
      const listener = async event => {
        if (event.source !== frame.contentWindow || event.origin !== location.origin || event.data?.channel !== 'article-voice-test') return;
        try { const value = await handle(event.data.message); event.source.postMessage({ id: event.data.id, ok: true, value }, location.origin); }
        catch (error) { event.source.postMessage({ id: event.data.id, ok: false, error: error.message }, location.origin); }
      };
      window.addEventListener('message', listener); return () => window.removeEventListener('message', listener);
    } });
}
document.getElementById('open-reader').onclick = openReader;
const wait = async (predicate, message, timeout = 30_000) => {
  const end = performance.now() + timeout;
  while (performance.now() < end) {
    const player = reader?.frame.contentWindow.testPlayer;
    if (player?.session.unavailable) throw new Error(reader.frame.contentWindow.document.getElementById('error').textContent || message);
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error(message);
};
document.getElementById('run-checks').onclick = async event => {
  event.target.disabled = true;
  const messages = [], pass = text => { messages.push(`PASS · ${text}`); output.textContent = messages.join('\n'); };
  try {
    clearTimeout(labelTimer);
    document.getElementById('kr-scrubber-bar').removeAttribute('aria-label');
    await openReader();
    await wait(() => reader.frame.contentWindow.testPlayer?.engine.segments.length, 'Initial OCR did not finish');
    const win = reader.frame.contentWindow, player = win.testPlayer, $ = id => win.document.getElementById(id);
    if (!player.engine.article.blocks.join(' ').includes('A quiet room waits')) throw new Error('Real Vision OCR did not return the book text');
    document.getElementById('kr-scrubber-bar').setAttribute('aria-label', `Page ${index + 1}`);
    pass('Kindle adapter reads an image through actual Apple Vision OCR');
    $('speed').value = '3'; $('speed').dispatchEvent(new Event('change')); $('play').click();
    await wait(() => {
      if (player.session.unavailable) throw new Error($('error').textContent);
      return player.engine.state === 'playing';
    }, 'Playback did not start');
    await wait(() => document.querySelector('#article-voice-marks > div:last-child')?.childElementCount > 0, 'First word mark did not appear');
    // These deliberately short fixture pages can finish before two future
    // pages generate. Hold the first page to inspect the prepared queue, then
    // resume for an actual audio-driven transition.
    $('play').click(); await wait(() => player.engine.state === 'paused', 'Initial pause did not take effect');
    await wait(() => player.session.future.size === 2 && [...player.session.future.values()].every(record => record.ready), 'Two future pages were not prepared');
    await wait(() => !player.session.pending, 'Page preparation did not settle');
    if (index !== 0 || document.querySelector('[data-article-voice-page]') || document.getElementById('main-content').inert) throw new Error('Prefetch did not restore the visible page');
    if (refusedTurns) throw new Error('Navigation was attempted before the previous turn settled');
    pass('Two pages queue ahead; restoration waits for each turn to settle and survives changing location labels');
    await wait(() => document.querySelector('#article-voice-marks > div:last-child')?.childElementCount > 0, 'OCR word overlay is missing');
    if (!$('follow').checked) throw new Error('Follow words is not available');
    pass('Spoken words are marked over the image; Follow words remains available');
    const first = player.session.unit.id;
    await render();
    await new Promise(resolve => setTimeout(resolve, 600));
    if (player.session.unavailable || player.session.unit.id !== first) throw new Error('A same-page image repaint stopped the reader');
    pass('Replacing the image URL with the same page contents keeps the prepared reading');
    $('play').click(); await wait(() => player.engine.state === 'playing', 'Playback did not resume');
    await wait(() => player.session.unit.id !== first, 'Audio completion did not turn the page', 60_000);
    $('play').click();
    await wait(() => player.engine.state === 'paused', 'Pause did not take effect');
    await wait(() => !player.session.pending, 'Refill did not settle');
    if (index !== 1 || player.engine.speed !== 3 || !player.engine.segments[0].result) throw new Error('Page transition lost ready audio, position or speed');
    const paused = player.session.unit.id;
    await new Promise(resolve => setTimeout(resolve, 1500));
    if (player.session.unit.id !== paused) throw new Error('Pages changed while paused');
    pass('Audio completion presents the next page with cached speech at 3×; Pause prevents further turns');
    const manualTurn = direction => {
      const button = document.getElementById(direction > 0 ? 'kr-chevron-right' : 'kr-chevron-left');
      button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
      button.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
    };
    manualTurn(1);
    await wait(() => player.session.unit.id !== paused && !player.session.needsRefresh, 'Manual page change did not reconnect');
    if (player.engine.wantsPlay || index !== 2 || !$('error').hidden) throw new Error('Manual navigation lost paused state');
    pass('A manual page turn reconnects to the visible page and keeps playback paused');
    const beforeLayout = player.session.unit.id;
    await render(.9);
    await wait(() => player.session.unit.id !== beforeLayout && !player.session.needsRefresh, 'Layout change did not reconnect');
    if (index !== 2 || player.engine.wantsPlay || !$('error').hidden) throw new Error('Layout change lost page or pause state');
    pass('A page-image layout change reconnects without a fatal error and preserves pause');
    const manual = player.session.unit.id;
    $('play').click(); await wait(() => player.engine.state === 'playing', 'Playback did not start before manual navigation');
    await wait(() => !player.session.pending, 'Preparation did not settle before manual navigation');
    manualTurn(-1);
    await wait(() => player.session.unit.id !== manual && player.engine.state === 'playing', 'Playing reader did not follow manual navigation');
    if (index !== 1 || !$('error').hidden) throw new Error('Manual navigation did not adopt the actual page');
    pass('Manual navigation while playing reads the newly visible page and rebuilds the queue');
    await wait(() => !player.session.pending, 'Preparation did not settle before cancellation check');
    const gate = heldRecognition = {};
    manualTurn(1);
    await wait(() => gate.started, 'Reconnection did not begin recognition');
    await player.session.stop(); gate.release();
    await new Promise(resolve => setTimeout(resolve, 600));
    if (player.engine.wantsPlay || player.session.future.size || !$('error').hidden) throw new Error('Stop during reconnection left playback or an error');
    pass('Stop during reconnection cancels recognition and prevents late playback');
    $('play').click();
    await wait(() => !player.session.needsRefresh && player.engine.state === 'playing', 'Play did not retry the visible page after Stop');
    if (index !== 2 || !$('error').hidden) throw new Error('Reconnection retry read a stale page');
    pass('Play after cancellation reconnects to the actual visible page');
    await player.session.stop();
    if (player.session.future.size || document.getElementById('main-content').inert) throw new Error('Stop left work or controls locked');
    await reader.cleanup();
    if (document.getElementById('article-voice-marks') || document.querySelector('[data-article-voice-page]')) throw new Error('Close left source overlays');
    pass('Stop and Close restore navigation and remove source marks');
    document.body.dataset.sourceChecks = 'passed'; pass('SOURCE ADAPTER CHECKS PASSED');
  } catch (error) {
    try { await reader?.frame.contentWindow.testPlayer?.session.stop(); await reader?.cleanup(); } catch {}
    messages.push(`FAIL · ${error.message}`); output.textContent = messages.join('\n'); document.body.dataset.sourceChecks = 'failed';
  }
  finally { event.target.disabled = false; }
};
