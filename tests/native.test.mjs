import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeRequest } from '../src/native.js';

function transport(t, reply) {
  let receive, disconnected, request, stopped = 0;
  const port = { onMessage: { addListener(fn) { receive = fn; } }, onDisconnect: { addListener(fn) { disconnected = fn; } },
    postMessage(value) { request = value; queueMicrotask(() => reply(value, receive, disconnected)); },
    disconnect() { stopped++; disconnected(); } };
  globalThis.chrome = { runtime: { connectNative(host) { assert.equal(host, 'com.articlevoice.chrome'); return port; } } };
  t.after(() => { delete globalThis.chrome; });
  return { get request() { return request; }, get stopped() { return stopped; } };
}

test('native transport assembles bounded audio chunks and closes its host port', async t => {
  const wire = transport(t, (request, send) => {
    send({ type: 'progress', message: 'Preparing voices' });
    send({ type: 'audio', value: { sampleRate: 24000, duration: 1 } });
    send({ type: 'chunk', data: 'AAAB' }); send({ type: 'chunk', data: 'AAAC' }); send({ type: 'done' });
  });
  const progress = [];
  const value = await nativeRequest('speech', { text: 'hello', voice: 'Ryan' }, undefined, item => progress.push(item.message));
  assert.equal(value.pcm, 'AAABAAAC'); assert.equal(value.duration, 1);
  assert.deepEqual(wire.request, { method: 'speech', payload: { text: 'hello', voice: 'Ryan' } });
  assert.equal(wire.stopped, 1); assert.deepEqual(progress, ['Preparing voices']);
});

test('native transport distinguishes missing setup, truncated audio, and cancellation', async t => {
  transport(t, (_request, send, end) => { send({ type: 'audio', value: {} }); end(); });
  await assert.rejects(nativeRequest('speech', {}), /connection stopped/);
  const wire = transport(t, () => {}), controller = new AbortController();
  const pending = nativeRequest('voices', undefined, controller.signal); controller.abort();
  await assert.rejects(pending, { name: 'AbortError' }); assert.equal(wire.stopped, 1);
  await assert.rejects(nativeRequest('voices', undefined, controller.signal), { name: 'AbortError' });
});

test('native transport returns actionable setup errors and rejects invalid message order', async t => {
  transport(t, (_request, send) => send({ type: 'error', error: 'Resume model setup in Article Voice.' }));
  await assert.rejects(nativeRequest('voices'), /Resume model setup/);
  transport(t, (_request, send) => send({ type: 'chunk', data: 'AAAB' }));
  await assert.rejects(nativeRequest('speech', {}), /incomplete response/);
});
