import test from 'node:test';
import assert from 'node:assert/strict';
import { ScrollFollow } from '../src/follow.js';
import { playerPreferences } from '../src/preferences.js';
import { LOCAL_CONFIG } from '../src/local.js';

test('manual scrolling pauses follow for ten seconds after the latest gesture, independently of playback', () => {
  let now = 1000; const follow = new ScrollFollow(() => now);
  assert.equal(follow.canScroll, true);
  follow.pause(); now = 10999; assert.equal(follow.canScroll, false);
  now = 11000; assert.equal(follow.canScroll, true);
  follow.pause(); now = 18000; follow.pause(); now = 27999; assert.equal(follow.canScroll, false);
  now = 28000; assert.equal(follow.canScroll, true);
  follow.setEnabled(false); now += 20000; assert.equal(follow.canScroll, false);
  follow.pause(); follow.setEnabled(true); assert.equal(follow.canScroll, true);
});

test('player defaults to passage playback and compact view; whole article and saved views remain selectable', () => {
  assert.equal(playerPreferences().mode, 'stream');
  assert.equal(playerPreferences().layout, 'compact');
  for (const layout of ['minimal', 'compact', 'full']) assert.equal(playerPreferences({ layout, mode: 'ahead' }).layout, layout);
  assert.equal(playerPreferences({ mode: 'ahead' }).mode, 'ahead');
  assert.equal(playerPreferences({ layout: 'unknown', mode: 'unknown' }).layout, 'compact');
  assert.equal(playerPreferences({ model: 'old-model' }).model, LOCAL_CONFIG.model);
});

test('Mac player restores its local voice without exposing or selecting a cloud model', () => {
  const cloud = { provider: 'cartesia', model: 'sonic-3', voiceId: 'cloud-voice', apiKey: 'existing-key',
    providerProfiles: { local: { voiceId: 'Ryan', voiceName: 'Ryan', voiceLibrary: [] } } };
  const current = playerPreferences(cloud, true);
  assert.equal(current.provider, 'local'); assert.equal(current.voiceId, 'Ryan');
  assert.equal(current.model, LOCAL_CONFIG.model); assert.equal(current.apiKey, cloud.apiKey);
  assert.equal(cloud.provider, 'cartesia');
});
