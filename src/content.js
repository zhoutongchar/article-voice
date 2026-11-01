import { ScrollFollow, SCROLL_PAUSE_MS } from './follow.js';
import { createSource } from './sources/registry.js';
import { SourceHost } from './sources/host.js';
import { recognizeImage } from './sources/recognize.js';

export function mountReader({ openFrame, onRequest, createAdapter = createSource, recognize = recognizeImage, sendEvent = message => chrome.runtime.sendMessage(message) } = {}) {
  const existing = document.getElementById('article-voice-host');
  if (existing) { existing.style.display = ''; return; }
  let article, source, renewal = Promise.resolve(), sourceVersion = 0, closed = false;
  const host = document.createElement('div');
  host.id = 'article-voice-host';
  host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;right:20px;bottom:20px;width:408px;max-width:calc(100vw - 24px);height:332px;max-height:calc(100vh - 32px);border-radius:22px;box-shadow:0 20px 80px #0005;overflow:hidden;color-scheme:light;';
  const shadow = host.attachShadow({ mode: 'open' });
  const frame = document.createElement('iframe');
  frame.title = 'Article Voice player'; frame.allow = 'autoplay';
  frame.style.cssText = 'width:100%;height:100%;border:0;background:#f7f9f8;border-radius:22px;';
  frame.src = openFrame || chrome.runtime.getURL('player.html');
  shadow.append(frame); document.documentElement.append(host);
  const style = document.createElement('style');
  style.textContent = '::highlight(article-voice-word){background:#ffcb4b!important;color:#171c18!important;text-decoration:underline;text-decoration-color:#ab6e00;text-decoration-thickness:2px;}::highlight(article-voice-passage){background:#c9efd666!important;color:inherit;}';
  document.head.append(style);
  const marks = document.createElement('div');
  marks.id = 'article-voice-marks';
  marks.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483646;';
  const passageMarks = document.createElement('div'), wordMarks = document.createElement('div');
  marks.append(passageMarks, wordMarks); document.documentElement.append(marks);
  const paint = (container, rects, color) => {
    container.replaceChildren(...rects.map(rect => {
      const marker = document.createElement('div');
      marker.style.cssText = `position:absolute;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;background:${color};border-radius:2px;`;
      return marker;
    }));
  };
  const follow = new ScrollFollow();
  let lastBlock = -1, followTimer, scrollFrame, dragging = false, pointerHeld = false;
  const cancelScroll = () => { cancelAnimationFrame(scrollFrame); scrollFrame = undefined; };
  const movePage = (top, smooth) => {
    cancelScroll();
    if (!smooth || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      window.scrollTo({ top, behavior: 'instant' }); return;
    }
    // Own the animation so a wheel/touch/key gesture can cancel it before its
    // next frame. Browser-native smooth scrolling can leave a queued movement
    // after an instant scroll attempts to cancel it.
    const from = window.scrollY, started = performance.now();
    const step = time => {
      if (!follow.canScroll) return;
      const progress = Math.min(1, (time - started) / 280);
      window.scrollTo({ top: from + (top - from) * (1 - (1 - progress) ** 3), behavior: 'instant' });
      scrollFrame = progress < 1 ? requestAnimationFrame(step) : undefined;
    };
    scrollFrame = requestAnimationFrame(step);
  };
  const fromPlayer = event => event.composedPath().includes(host);
  const notifyFollow = pausedUntil => Promise.resolve(sendEvent({ type: 'follow-state', pausedUntil })).catch(() => {});
  const pauseFollowing = () => {
    if (!follow.enabled) return;
    follow.pause(); clearTimeout(followTimer); cancelScroll();
    notifyFollow(Date.now() + SCROLL_PAUSE_MS);
    followTimer = setTimeout(() => notifyFollow(0), SCROLL_PAUSE_MS);
  };
  const manualScroll = event => { if (!fromPlayer(event)) pauseFollowing(); };
  const scrollKey = event => {
    if (fromPlayer(event) || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey
      || event.target?.closest?.('input,textarea,select,button,[contenteditable]:not([contenteditable="false"])')) return;
    if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) pauseFollowing();
  };
  const dragMove = event => {
    if (pointerHeld && pointer && !fromPlayer(event) && Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) > 3) dragging = true;
  };
  const dragScroll = () => { if (dragging) pauseFollowing(); };
  const pointerUp = () => { dragging = false; pointerHeld = false; };
  let interrupted = false;
  const highlights = CSS.highlights;
  const passageHighlight = new Highlight(), wordHighlight = new Highlight();
  wordHighlight.priority = 1;
  let highlightedBlock = null, highlightedWord = '';
  function clear() {
    cancelScroll();
    highlights?.delete('article-voice-word'); highlights?.delete('article-voice-passage');
    passageHighlight.clear(); wordHighlight.clear(); highlightedBlock = null; highlightedWord = '';
    passageMarks.replaceChildren(); wordMarks.replaceChildren();
  }
  // Some browser-control sessions replace extension frames with an empty
  // srcdoc. Explain the interruption without undoing that replacement or
  // attempting to access the protected extension document.
  function showInterruption() {
    if (interrupted || !frame.hasAttribute('srcdoc')) return;
    interrupted = true; clear(); frame.style.display = 'none'; host.style.height = '240px';
    const notice = document.createElement('div'); notice.setAttribute('role', 'alert');
    notice.style.cssText = 'box-sizing:border-box;padding:24px;height:100%;background:#f7f9f8;color:#263e32;font:14px/1.6 system-ui;';
    const title = document.createElement('strong'); title.textContent = 'Give the reader a fresh start';
    const detail = document.createElement('p');
    detail.textContent = 'Browser automation may be interfering with the player. End browser control, refresh this page, then open Article Voice again.';
    const close = document.createElement('button'); close.textContent = 'Close reader';
    close.style.cssText = 'border:0;border-radius:8px;background:#2f654f;color:white;padding:9px 14px;cursor:pointer;font:600 13px system-ui;';
    close.onclick = cleanup; notice.append(title, detail, close); shadow.append(notice);
  }
  const interruptionObserver = new MutationObserver(showInterruption);
  interruptionObserver.observe(frame, { attributes: true, attributeFilter: ['srcdoc'] });
  showInterruption();
  function highlight(info) {
    if (!info || !article) { clear(); return { word: '', scroll: window.scrollY }; }
    if (!article.blocks[info.block]) { clear(); return { word: '' }; }
    const block = `${article.id}:${info.block}`;
    if (highlightedBlock !== block) {
      const passage = source.span(info.block);
      if (!passage) { clear(); return { word: '', stale: true }; }
      passageHighlight.clear();
      if (passage.range) { passageHighlight.add(passage.range); highlights?.set('article-voice-passage', passageHighlight); }
      else paint(passageMarks, passage.rects, '#c9efd666');
      highlightedBlock = block;
    }
    if (info.start == null || info.end == null) {
      wordHighlight.clear(); highlightedWord = '';
      wordMarks.replaceChildren();
      return { word: '', scroll: window.scrollY };
    }
    const wordKey = `${info.block}:${info.start}:${info.end}`;
    const word = source.span(info.block, info.start, info.end);
    if (!word) { clear(); return { word: '', stale: true }; }
    if (highlightedWord !== wordKey) {
      wordHighlight.clear();
      if (word.range) {
        wordHighlight.add(word.range);
        if (!highlights?.has('article-voice-word')) highlights?.set('article-voice-word', wordHighlight);
      } else paint(wordMarks, word.rects, '#ffcb4bbf');
      highlightedWord = wordKey;
    }
    const rect = word.rects[0];
    if (!rect) { clear(); return { word: '', stale: true }; }
    if (article.source.scroll !== false && follow.canScroll && !pointerHeld && (rect.top < 90 || rect.bottom > innerHeight - 160)) {
      const target = rect.top + window.scrollY - innerHeight * 0.35;
      movePage(Math.max(0, target), lastBlock !== info.block);
    }
    lastBlock = info.block;
    return { word: word.text, scroll: window.scrollY,
      rect: { top: rect.top, bottom: rect.bottom }, highlighted: highlights?.has('article-voice-word') || !!wordMarks.childElementCount };
  }
  const newSource = () => new SourceHost(createAdapter({ document, url: new URL(location.href), recognize,
        onChange: event => {
          clear();
          if (event?.type !== 'repaint') Promise.resolve(sendEvent({
            type: event?.type === 'page' ? 'source-page' : 'source-changed', reason: event?.reason
          })).catch(() => {});
        } }));
  const handle = message => {
    if (message.type === 'source-refresh') {
      clear(); const version = ++sourceVersion;
      renewal = renewal.catch(() => {}).then(async () => {
        await source?.dispose();
        if (closed || version !== sourceVersion) throw new DOMException('Cancelled', 'AbortError');
        source = newSource();
        return article = await source.open();
      });
      return renewal;
    }
    if (message.type === 'article') {
      source ||= newSource();
      return source.open().then(value => article = value);
    }
    if (message.type === 'source-next') return source.prepareNext(message.after, message.count);
    if (message.type === 'source-present') { clear(); return source.present(message.id).then(value => article = value); }
    if (message.type === 'source-cancel') {
      sourceVersion++;
      return Promise.all([source?.cancel(), renewal.catch(() => {})]).then(([actual]) => actual);
    }
    if (message.type === 'highlight') return highlight(message.value);
    if (message.type === 'follow') {
      follow.setEnabled(message.value); clearTimeout(followTimer); notifyFollow(0);
      // Cancel an already-running smooth scroll when follow is switched off.
      if (!follow.enabled) cancelScroll();
      return {};
    }
    if (message.type === 'resize' && Number.isFinite(message.height) && ['minimal', 'compact', 'full'].includes(message.layout)) {
      const minimal = message.layout === 'minimal';
      host.style.height = `${Math.max(48, Math.min(680, message.height))}px`;
      host.style.width = `${minimal ? 480 : 408}px`;
      host.style.borderRadius = minimal ? '14px' : '22px';
      frame.style.borderRadius = 'inherit'; return {};
    }
    if (message.type === 'close') return Promise.resolve(cleanup()).then(() => ({}));
  };
  const listener = (message, sender, reply) => {
    if (sender.id !== chrome.runtime.id) return;
    try {
      const result = handle(message);
      if (result?.then) { result.then(value => reply({ ok: true, value }), error => reply({ ok: false, error: error.message })); return true; }
      if (result !== undefined) reply({ ok: true, value: result });
    }
    catch (error) { reply({ ok: false, error: error.message }); }
  };
  let pointer;
  const pointerDown = event => {
    if (fromPlayer(event)) return;
    cancelScroll();
    pointer = { x: event.clientX, y: event.clientY }; dragging = false; pointerHeld = true;
    if (event.clientX >= document.documentElement.clientWidth) pauseFollowing();
  };
  const clickWord = event => {
    if (interrupted || !article || event.defaultPrevented || event.button !== 0 || event.detail > 1
      || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
      || !window.getSelection()?.isCollapsed
      || (pointer && Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) > 5)) return;
    if (!(event.target instanceof Element) || event.target.isContentEditable
      || event.target.closest('a,button,input,textarea,select,summary,[role="button"],[role="link"],#article-voice-host')) return;
    const position = source.wordAtPoint(event.clientX, event.clientY);
    if (position) {
      if (article.source.pagination) { event.preventDefault(); event.stopImmediatePropagation(); }
      Promise.resolve(sendEvent({ type: 'seek-word', ...position })).catch(() => {});
    }
  };
  document.addEventListener('pointerdown', pointerDown, { passive: true });
  document.addEventListener('click', clickWord, true);
  window.addEventListener('wheel', manualScroll, { passive: true });
  window.addEventListener('touchmove', manualScroll, { passive: true });
  document.addEventListener('keydown', scrollKey);
  document.addEventListener('pointermove', dragMove, { passive: true });
  document.addEventListener('pointerup', pointerUp);
  document.addEventListener('pointercancel', pointerUp);
  document.addEventListener('scroll', dragScroll, { capture: true, passive: true });
  let bridgeCleanup;
  function cleanup() {
    closed = true; sourceVersion++;
    interruptionObserver.disconnect();
    clear(); host.remove(); style.remove(); marks.remove();
    document.removeEventListener('pointerdown', pointerDown);
    document.removeEventListener('click', clickWord, true);
    clearTimeout(followTimer); cancelScroll();
    window.removeEventListener('wheel', manualScroll);
    window.removeEventListener('touchmove', manualScroll);
    document.removeEventListener('keydown', scrollKey);
    document.removeEventListener('pointermove', dragMove);
    document.removeEventListener('pointerup', pointerUp);
    document.removeEventListener('pointercancel', pointerUp);
    document.removeEventListener('scroll', dragScroll, true);
    bridgeCleanup?.();
    if (!onRequest) chrome.runtime.onMessage.removeListener(listener);
    return Promise.all([source?.dispose(), renewal.catch(() => {})]).then(() => {});
  }
  if (onRequest) bridgeCleanup = onRequest(handle, frame);
  else chrome.runtime.onMessage.addListener(listener);
  return { host, frame, handle, cleanup };
}

if (typeof chrome !== 'undefined' && chrome.runtime?.id) mountReader();
