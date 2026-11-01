import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { bridge } from '../src/bridge.js';
import { registerBackground } from '../src/background.js';

function backgroundChrome() {
  const listeners = {}, requests = [], created = [], tabs = [];
  const event = name => ({ addListener(callback) { listeners[name] = callback; } });
  const chrome = { storage: { local: { setAccessLevel() {} } }, action: { onClicked: event('action') },
    alarms: { async get() { return null; }, async create(name, options) { created.push({ name, ...options }); }, onAlarm: event('alarm') },
    tabs: { async create(value) { tabs.push(value); } },
    runtime: { id: 'test', getURL: path => `chrome-extension://test/${path}`,
      onMessage: event('message'), onInstalled: event('installed'), onStartup: event('startup'),
      async sendNativeMessage(host, request) { requests.push({ host, request }); return { type: 'result', value: { connected: true } }; },
      async sendMessage() {} } };
  return { chrome, listeners, requests, created, tabs };
}

test('background routes page word clicks using the sender tab and identifies the player tab', async () => {
  let forwarded;
  const { chrome, listeners } = backgroundChrome();
  chrome.runtime.sendMessage = async message => { forwarded = message; };
  registerBackground(chrome);
  const listener = listeners.message;
  const input = { type: 'seek-word', block: 2, start: 5, end: 9, tabId: 999 };
  let reply;
  listener(input, { id: 'test', tab: { id: 7 }, frameId: 0, url: 'https://example.org' }, value => { reply = value; });
  await Promise.resolve();
  assert.equal(forwarded.tabId, 7); assert.equal(forwarded.start, 5); assert.equal(reply.ok, true);
  listener({ type: 'follow-state', pausedUntil: 1000, tabId: 999 },
    { id: 'test', tab: { id: 7 }, frameId: 0 }, value => { reply = value; });
  await Promise.resolve();
  assert.deepEqual(forwarded, { type: 'follow-state', tabId: 7, pausedUntil: 1000 });
  forwarded = null;
  listener(input, { id: 'foreign', tab: { id: 7 }, frameId: 0 }, () => {});
  assert.equal(forwarded, null);
  listener({ type: 'identify' }, { id: 'test', tab: { id: 7 }, url: 'chrome-extension://test/player.html' }, value => { reply = value; });
  assert.equal(reply.value.tabId, 7);
});

test('background maintains a lightweight heartbeat across idle alarms, browser startup and extension updates', async () => {
  const { chrome, listeners, requests, created, tabs } = backgroundChrome();
  registerBackground(chrome); await setImmediate();
  assert.deepEqual(created, [{ name: 'article-voice-connection', periodInMinutes: 0.5 }]);
  assert.deepEqual(requests, [{ host: 'com.articlevoice.chrome', request: { method: 'heartbeat' } }]);
  listeners.alarm({ name: 'unrelated' }); assert.equal(requests.length, 1);
  listeners.alarm({ name: 'article-voice-connection' }); await setImmediate();
  assert.equal(requests.length, 2);
  chrome.alarms.get = async () => ({ name: 'article-voice-connection' });
  listeners.startup(); listeners.installed({ reason: 'update' }); await setImmediate();
  assert.equal(requests.length, 4); assert.equal(created.length, 1); assert.equal(tabs.length, 0);
  listeners.installed({ reason: 'install' }); await setImmediate();
  assert.equal(requests.length, 5);
  assert.deepEqual(tabs, [{ url: 'chrome-extension://test/welcome.html' }]);
});

test('a missing companion is retried by later heartbeats without opening setup tabs', async () => {
  const { chrome, listeners, requests, tabs } = backgroundChrome();
  const send = chrome.runtime.sendNativeMessage;
  chrome.runtime.sendNativeMessage = async () => { throw new Error('Native host not found'); };
  registerBackground(chrome); await setImmediate();
  chrome.runtime.sendNativeMessage = send;
  listeners.alarm({ name: 'article-voice-connection' }); await setImmediate();
  assert.equal(requests.length, 1); assert.equal(tabs.length, 0);
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
  listener({ type: 'follow-state', tabId: 8, pausedUntil: 1000 }, { id: 'test' });
  listener({ type: 'follow-state', tabId: 7, pausedUntil: 1000 }, { id: 'test' });
  assert.equal(events.length, 2); assert.equal(events[1].pausedUntil, 1000);
  unsubscribe(); assert.equal(removed, true);
});

test('image recognition is restricted to a registered top-frame source and cancellation is scoped to the sender tab', async t => {
  const { chrome, listeners } = backgroundChrome(); let receive, requests = 0, closed = 0;
  chrome.runtime.connectNative = () => ({ onMessage: { addListener(fn) { receive = fn; } },
    onDisconnect: { addListener() {} }, postMessage(message) { requests++; assert.equal(message.method, 'ocr'); }, disconnect() { closed++; } });
  globalThis.chrome = chrome; t.after(() => { delete globalThis.chrome; }); registerBackground(chrome);
  const sender = { id: 'test', frameId: 0, tab: { id: 7 }, url: 'https://read.amazon.com/?asin=book' };
  const message = { type: 'source-ocr', id: 'ocr-one', payload: { image: 'fixture' } }; let result;
  listeners.message(message, { ...sender, url: 'https://example.org/' }, () => {});
  listeners.message(message, { ...sender, frameId: 1 }, () => {});
  listeners.message(message, { ...sender, id: 'foreign' }, () => {});
  assert.equal(requests, 0);
  listeners.message(message, sender, value => result = value);
  assert.equal(requests, 1);
  listeners.message({ type: 'source-ocr-cancel', id: 'ocr-one' }, { ...sender, tab: { id: 8 } }, () => {});
  assert.equal(closed, 0);
  receive({ type: 'result', value: { lines: [] } }); await setImmediate();
  assert.deepEqual(result, { ok: true, value: { lines: [] } }); assert.equal(closed, 1);
  listeners.message({ ...message, id: 'ocr-two' }, sender, value => result = value);
  listeners.message({ type: 'source-ocr-cancel', id: 'ocr-two' }, sender, () => {});
  await setImmediate(); assert.equal(closed, 2); assert.equal(result.ok, false);
});
