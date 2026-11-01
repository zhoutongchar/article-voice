import { Readability } from '@mozilla/readability';

const EXCLUDE = 'script,style,noscript,nav,header,footer,aside,button,input,textarea,select,svg,pre,[hidden],[aria-hidden="true"],[contenteditable="true"],#article-voice-host';
const BLOCKS = 'h1,h2,h3,h4,h5,h6,p,li,blockquote,td,figcaption';

function eligible(el) {
  if (!el || el.closest(EXCLUDE)) return false;
  const style = getComputedStyle(el);
  return style.display !== 'none' && style.visibility !== 'hidden' && el.getClientRects().length > 0;
}

// Keep a UTF-16 source coordinate for each normalized character. This lets a
// timestamp span inline links, emphasis, emoji, and collapsed whitespace.
export function textMap(element) {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  let node, text = '';
  const points = [];
  while ((node = walker.nextNode())) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      if (node.tagName === 'BR' && text && !text.endsWith(' ')) {
        const previous = points.at(-1);
        text += ' '; points.push(previous);
      }
      continue;
    }
    if (!eligible(node.parentElement)) continue;
    for (let i = 0; i < node.data.length; i++) {
      const char = node.data[i];
      if (/\s/.test(char)) {
        if (!text || text.endsWith(' ')) continue;
        text += ' ';
      } else text += char;
      points.push({ node, offset: i });
    }
  }
  if (text.endsWith(' ')) { text = text.slice(0, -1); points.pop(); }
  return { element, text, points };
}

export function extractArticle() {
  // Readability works on a clone; IDs link its surviving nodes back to the
  // original page. No article nodes are replaced or wrapped.
  const clone = document.cloneNode(true);
  const originals = [...document.querySelectorAll('*')];
  [...clone.querySelectorAll('*')].forEach((el, index) => el.setAttribute('data-av-source', String(index)));
  const parsed = new Readability(clone, { serializer: el => el, charThreshold: 60 }).parse();
  const kept = parsed?.content ? [...parsed.content.querySelectorAll('[data-av-source]')]
    .map(el => originals[Number(el.getAttribute('data-av-source'))]).filter(Boolean) : [];
  const semantic = document.querySelector('article, [role="article"], .markdown-body, main, [role="main"]');
  let candidates = kept.filter(el => el.matches(BLOCKS) && eligible(el));
  if (candidates.length < 2) candidates = [...(semantic || document.body).querySelectorAll(BLOCKS)].filter(eligible);
  // Only leaf blocks: a blockquote containing paragraphs must not be read twice.
  const selected = new Set(candidates);
  candidates = candidates.filter(el => ![...el.querySelectorAll(BLOCKS)].some(child => selected.has(child)));
  candidates.sort((a, b) => a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
  let blocks = candidates.map(textMap).filter(block => block.text.length > 1);
  if (!blocks.length && semantic && eligible(semantic)) blocks = [textMap(semantic)].filter(b => b.text);
  if (!blocks.length) throw new Error('No readable article found. Open an article with visible text, then try again.');
  return { title: parsed?.title || document.title, url: location.href,
    language: document.documentElement.lang?.split('-')[0] || '', blocks };
}

export function rangeFor(block, start = 0, end = block.text.length) {
  const first = block.points[start], last = block.points[Math.min(end, block.points.length) - 1];
  if (!first || !last || !first.node.isConnected || !last.node.isConnected) return null;
  const range = document.createRange();
  range.setStart(first.node, first.offset); range.setEnd(last.node, last.offset + 1);
  return range;
}

export function wordFromPoint(article, x, y) {
  const caret = document.caretPositionFromPoint?.(x, y);
  const fallback = !caret && document.caretRangeFromPoint?.(x, y);
  const node = caret?.offsetNode || fallback?.startContainer;
  const offset = caret?.offset ?? fallback?.startOffset;
  if (node?.nodeType !== Node.TEXT_NODE || offset == null) return null;
  for (const [index, block] of article.blocks.entries()) {
    if (!block.element.contains(node)) continue;
    let position = -1;
    for (let i = 0; i < block.points.length; i++) {
      const point = block.points[i];
      if (point.node !== node) continue;
      position = i + (point.offset < offset ? 1 : 0);
      if (point.offset >= offset) break;
    }
    if (position < 0) continue;
    for (const word of new Intl.Segmenter(undefined, { granularity: 'word' }).segment(block.text)) {
      const end = word.index + word.segment.length;
      if (!word.isWordLike || position < word.index || position > end) continue;
      const range = rangeFor(block, word.index, end);
      // A caret can snap to nearby text when clicking paragraph whitespace.
      // Only an actual glyph hit should change playback.
      if (range && [...range.getClientRects()].some(rect => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom))
        return { block: index, start: word.index, end };
    }
  }
  return null;
}

// Source paragraphs own speech boundaries. Visual line wraps and sentence
// length never create additional requests or interrupt a sentence's prosody.
export function paragraphPassages(blocks) {
  const result = [];
  for (const [block, item] of blocks.entries()) {
    let start = 0;
    const append = end => {
      const raw = item.text.slice(start, end), text = raw.trim();
      if (text) result.push({ block, offset: start + raw.indexOf(text), text });
    };
    for (const boundary of item.text.matchAll(/\r?\n[ \t]*\r?\n/g)) {
      append(boundary.index); start = boundary.index + boundary[0].length;
    }
    append(item.text.length);
  }
  return result;
}
