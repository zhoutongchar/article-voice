import { extractArticle, splitPassages, rangeFor, wordFromPoint } from './article.js';

export function mountReader({ openFrame, onRequest, sendEvent = message => chrome.runtime.sendMessage(message) } = {}) {
  const existing = document.getElementById('article-voice-host');
  if (existing) { existing.style.display = ''; return; }
  let article;
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
  let follow = true, lastBlock = -1;
  const highlights = CSS.highlights;
  const passageHighlight = new Highlight(), wordHighlight = new Highlight();
  wordHighlight.priority = 1;
  let highlightedBlock = null, highlightedWord = '';
  function clear() {
    highlights?.delete('article-voice-word'); highlights?.delete('article-voice-passage');
    passageHighlight.clear(); wordHighlight.clear(); highlightedBlock = null; highlightedWord = '';
  }
  function highlight(info) {
    if (!info || !article) { clear(); return { word: '', scroll: window.scrollY }; }
    const block = article.blocks[info.block];
    if (!block) { clear(); return { word: '' }; }
    if (highlightedBlock !== block) {
      const passage = rangeFor(block);
      if (!passage) { clear(); return { word: '', stale: true }; }
      passageHighlight.clear(); passageHighlight.add(passage);
      highlights?.set('article-voice-passage', passageHighlight);
      highlightedBlock = block;
    }
    if (info.start == null || info.end == null) {
      wordHighlight.clear(); highlightedWord = '';
      return { word: '', scroll: window.scrollY };
    }
    const wordKey = `${info.block}:${info.start}:${info.end}`;
    const word = rangeFor(block, info.start, info.end);
    if (!word) { clear(); return { word: '', stale: true }; }
    if (highlightedWord !== wordKey) {
      wordHighlight.clear(); wordHighlight.add(word);
      if (!highlights?.has('article-voice-word')) highlights?.set('article-voice-word', wordHighlight);
      highlightedWord = wordKey;
    }
    const rect = word.getBoundingClientRect();
    if (follow && (rect.top < 90 || rect.bottom > innerHeight - 160)) {
      const target = rect.top + window.scrollY - innerHeight * 0.35;
      window.scrollTo({ top: Math.max(0, target), behavior: lastBlock === info.block ? 'instant' : 'smooth' });
    }
    lastBlock = info.block;
    return { word: word.toString(), scroll: window.scrollY,
      rect: { top: rect.top, bottom: rect.bottom }, highlighted: highlights?.has('article-voice-word') || false };
  }
  const handle = message => {
    if (message.type === 'article') {
      article = extractArticle();
      return { title: article.title, url: article.url, language: article.language,
        blocks: article.blocks.map(b => b.text), passages: splitPassages(article.blocks) };
    }
    if (message.type === 'highlight') return highlight(message.value);
    if (message.type === 'follow') {
      follow = message.value;
      // Cancel an already-running smooth scroll when follow is switched off.
      if (!follow) window.scrollTo({ top: window.scrollY, left: window.scrollX, behavior: 'instant' });
      return {};
    }
    if (message.type === 'resize') { host.style.height = `${Math.max(280, Math.min(680, message.height))}px`; return {}; }
    if (message.type === 'close') { cleanup(); return {}; }
  };
  const listener = (message, sender, reply) => {
    if (sender.id !== chrome.runtime.id) return;
    try { const result = handle(message); if (result !== undefined) reply({ ok: true, value: result }); }
    catch (error) { reply({ ok: false, error: error.message }); }
  };
  let pointer;
  const pointerDown = event => { pointer = { x: event.clientX, y: event.clientY }; };
  const clickWord = event => {
    if (!article || event.defaultPrevented || event.button !== 0 || event.detail > 1
      || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
      || !window.getSelection()?.isCollapsed
      || (pointer && Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) > 5)) return;
    if (!(event.target instanceof Element) || event.target.isContentEditable
      || event.target.closest('a,button,input,textarea,select,summary,[role="button"],[role="link"],#article-voice-host')) return;
    const position = wordFromPoint(article, event.clientX, event.clientY);
    if (position) Promise.resolve(sendEvent({ type: 'seek-word', ...position })).catch(() => {});
  };
  document.addEventListener('pointerdown', pointerDown, { passive: true });
  document.addEventListener('click', clickWord);
  let bridgeCleanup;
  function cleanup() {
    clear(); host.remove(); style.remove();
    document.removeEventListener('pointerdown', pointerDown);
    document.removeEventListener('click', clickWord);
    bridgeCleanup?.();
    if (!onRequest) chrome.runtime.onMessage.removeListener(listener);
  }
  if (onRequest) bridgeCleanup = onRequest(handle, frame);
  else chrome.runtime.onMessage.addListener(listener);
  return { host, frame, handle, cleanup };
}

if (typeof chrome !== 'undefined' && chrome.runtime?.id) mountReader();
