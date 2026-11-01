import connection from '../chrome/connection.json' with { type: 'json' };

export const hasNative = () => typeof chrome !== 'undefined' && typeof chrome.runtime?.connectNative === 'function';

export function nativeRequest(method, payload, signal, progress = () => {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('Cancelled', 'AbortError')); return; }
    let port, settled = false, audio, chunks = [], size = 0;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; signal?.removeEventListener('abort', abort);
      port?.disconnect();
      if (error) reject(error); else resolve(value);
    };
    const abort = () => finish(new DOMException('Cancelled', 'AbortError'));
    try {
      port = chrome.runtime.connectNative(connection.host);
      signal?.addEventListener('abort', abort, { once: true });
      port.onMessage.addListener(message => {
        if (message?.type === 'progress') { progress(message); return; }
        if (message?.type === 'error') { finish(Object.assign(new Error(message.error), { code: message.code, stage: message.stage, retryable: message.retryable })); return; }
        if (message?.type === 'result') { finish(null, message.value); return; }
        if (message?.type === 'audio' && !audio) { audio = message.value; return; }
        if (message?.type === 'chunk' && audio && typeof message.data === 'string') {
          size += message.data.length;
          if (size > 32 * 1024 * 1024) { finish(new Error('This passage returned too much audio. Try a shorter passage.')); return; }
          chunks.push(message.data); return;
        }
        if (message?.type === 'done' && audio && chunks.length) {
          finish(null, { ...audio, pcm: chunks.join('') }); return;
        }
        finish(new Error('The voice connection returned an incomplete response. Try again.'));
      });
      port.onDisconnect.addListener(() => {
        const detail = chrome.runtime.lastError?.message;
        if (!settled) finish(new Error(detail?.includes('host not found') || detail?.includes('not found')
          ? 'Open Article Voice once to finish connecting Chrome, then try again.'
          : 'The voice connection stopped. Open Article Voice and click Retry.'));
      });
      port.postMessage({ method, ...(payload ? { payload } : {}) });
    } catch { finish(new Error('Open Article Voice to connect your local voices.')); }
  });
}
