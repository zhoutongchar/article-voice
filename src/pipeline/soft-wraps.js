import { transformContent } from './contracts.js';

// OCR line breaks describe layout. Keep them available to the optional LLM,
// then remove soft wraps before speech even when formatting was rejected or
// disabled. Paragraph boundaries and every non-whitespace character survive.
export async function unwrapContent(content) {
  const edits = content.paragraphs.flatMap(paragraph => [...content.text.slice(paragraph.start, paragraph.end)
    .matchAll(/[ \t]*(?:\r?\n[ \t]*)+/g)].map(match => ({
      start: paragraph.start + match.index, end: paragraph.start + match.index + match[0].length,
      text: content.text[paragraph.start + match.index - 1] === '-' ? '' : ' '
    })));
  if (!edits.length) return content;
  let text = '', cursor = 0;
  const spans = [];
  const copy = end => {
    if (end > cursor) {
      spans.push({ start: text.length, end: text.length + end - cursor, from: cursor, to: end, identity: true });
      text += content.text.slice(cursor, end);
    }
    cursor = end;
  };
  for (const edit of edits) {
    copy(edit.start);
    spans.push({ start: text.length, end: text.length + edit.text.length, from: edit.start, to: edit.end, identity: false });
    text += edit.text; cursor = edit.end;
  }
  copy(content.text.length);
  return transformContent(content, { original: content.text, text, spans });
}
