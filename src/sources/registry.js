import { createArticleSource } from './article.js';
import { createKindleSource } from './kindle.js';

export const sourceAdapters = [
  { id: 'kindle', imageReading: true, matches: ({ url }) => url.hostname === 'read.amazon.com' && !!url.searchParams.get('asin'), create: createKindleSource },
  { id: 'article', matches: () => true, create: createArticleSource }
];

export function createSource(context, adapters = sourceAdapters) {
  const selected = adapters.find(adapter => adapter.matches(context));
  if (!selected) throw new Error('This page does not have a supported reading source.');
  return selected.create(context);
}

export function isImageSourceUrl(value) {
  try { return !!sourceAdapters.find(adapter => adapter.matches({ url: new URL(value) }))?.imageReading; }
  catch { return false; }
}
