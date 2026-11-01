import { randomId } from '../hash.js';
export function recognizeImage(image, signal) {
  const id = randomId();
  return new Promise((resolve, reject) => {
    const abort = () => {
      chrome.runtime.sendMessage({ type: 'source-ocr-cancel', id }).catch(() => {});
      reject(new DOMException('Cancelled', 'AbortError'));
    };
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    chrome.runtime.sendMessage({ type: 'source-ocr', id, payload: { image } }).then(reply => {
      if (signal?.aborted) return;
      if (reply?.ok) resolve(reply.value);
      else reject(new Error(reply?.error || 'Update Article Voice on this Mac to enable image reading.'));
    }, reject).finally(() => signal?.removeEventListener('abort', abort));
  });
}
