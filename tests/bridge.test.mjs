import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { bridge } from '../src/bridge.js';

test('background routes page word clicks using the sender tab and identifies the player tab', async () => {
  let listener, forwarded;
  const chrome = { storage: { local: { setAccessLevel() {} } }, action: { onClicked: { addListener() {} } },
    runtime: { id: 'test', getURL: path => `chrome-extension://test/${path}`, onMessage: { addListener(callback) { listener = callback; } },
      async sendMessage(message) { forwarded = message; } } };
  vm.runInNewContext(await readFile(new URL('../src/background.js', import.meta.url), 'utf8'), { chrome });
  const input = { type: 'seek-word', block: 2, start: 5, end: 9, tabId: 999 };
  let reply;
  listener(input, { id: 'test', tab: { id: 7 }, frameId: 0, url: 'https://example.org' }, value => { reply = value; });
  await Promise.resolve();
  assert.equal(forwarded.tabId, 7); assert.equal(forwarded.start, 5); assert.equal(reply.ok, true);
  forwarded = null;
  listener(input, { id: 'foreign', tab: { id: 7 }, frameId: 0 }, () => {});
  assert.equal(forwarded, null);
  listener({ type: 'identify' }, { id: 'test', tab: { id: 7 }, url: 'chrome-extension://test/player.html' }, value => { reply = value; });
  assert.equal(reply.value.tabId, 7);
});

test('player receives word clicks only from its own tab and removes its listener on cleanup', async t => {
  let listener, removed = false;
  globalThis.chrome = { runtime: { id: 'test', async sendMessage() { return { ok: true, value: { tabId: 7 } }; },
    onMessage: { addListener(callback) { listener = callback; }, removeListener(callback) { removed = callback === listener; } } } };
  t.after(() => { delete globalThis.chrome; });
  const events = [], unsubscribe = await bridge.subscribe(message => events.push(message));
  listener({ type: 'seek-word', tabId: 8 }, { id: 'test' });
  listener({ type: 'seek-word', tabId: 7 }, { id: 'foreign' });
  assert.equal(events.length, 0);
  listener({ type: 'seek-word', tabId: 7, block: 0, start: 0, end: 5 }, { id: 'test' });
  assert.equal(events.length, 1); unsubscribe(); assert.equal(removed, true);
});
