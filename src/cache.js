import { LOCAL_CONFIG, isReferenceId } from './local.js';
const MAX_BYTES = 128 * 1024 * 1024;
let database;
async function db() {
  if (!database) database = new Promise((resolve, reject) => {
    const request = indexedDB.open('article-voice-audio', 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('audio', { keyPath: 'key' });
      request.result.createObjectStore('metadata', { keyPath: 'key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return database;
}
async function transaction(mode, action, names = ['audio']) {
  const database = await db();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(names, mode);
    const request = action(tx.objectStore(names[0]), tx);
    tx.oncomplete = () => resolve(request?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
export const audioCache = {
  async get(key) { return (await transaction('readonly', store => store.get(key)))?.value; },
  async set(key, value) {
    await transaction('readwrite', (store, tx) => {
      store.put({ key, value });
      tx.objectStore('metadata').put({ key, bytes: value.pcm.byteLength, time: Date.now() });
    }, ['audio', 'metadata']);
    // Read only the small metadata records when enforcing the cache budget.
    const entries = await transaction('readonly', store => store.getAll(), ['metadata']);
    let total = entries.reduce((sum, item) => sum + item.bytes, 0);
    for (const entry of entries.sort((a, b) => a.time - b.time)) {
      if (total <= MAX_BYTES) break;
      await transaction('readwrite', (store, tx) => {
        store.delete(entry.key); tx.objectStore('metadata').delete(entry.key);
      }, ['audio', 'metadata']); total -= entry.bytes;
    }
  },
  async clear() { await transaction('readwrite', (store, tx) => { store.clear(); tx.objectStore('metadata').clear(); }, ['audio', 'metadata']); }
};

export async function cacheKey(text, settings) {
  if (settings.provider === 'local' && !isReferenceId(settings.voiceReferenceId))
    throw new Error('Connect the local server to load its fixed voice reference.');
  const identity = settings.provider === 'local'
    ? ['local', LOCAL_CONFIG.pipeline, LOCAL_CONFIG.revision, LOCAL_CONFIG.alignerRevision, LOCAL_CONFIG.generation, settings.voiceReferenceId]
    : ['cartesia', '2026-08-14'];
  const bytes = new TextEncoder().encode(JSON.stringify([...identity, settings.provider === 'local' ? LOCAL_CONFIG.model : settings.model,
    settings.voiceId, settings.language || '', 'pcm_s16le', 24000, text]));
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(v => v.toString(16).padStart(2, '0')).join('');
}
