import { ReaderEngine } from './engine.js';
import { canGenerate, providerVoices } from './providers.js';
import { LOCAL_CONFIG } from './local.js';
import { audioCache } from './cache.js';
import { bridge } from './bridge.js';
import { hasNative } from './native.js';
import { splitPassages } from './article.js';
import { parseVoice, PREVIEW_TEXT } from './voices.js';
import { playerPreferences } from './preferences.js';

export async function startPlayer({ transport = bridge, generate, cache, audio, loadVoices = providerVoices } = {}) {
  const $ = id => document.getElementById(id);
  const time = value => `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, '0')}`;
  const savedSettings = await transport.settings();
  let article, settings = playerPreferences(savedSettings, hasNative());
  await transport.save(settings);
  let voiceAbort, hasLoadedVoices = false, visibleVoices = [], unsubscribe = () => {};
  let previousView = settings.layout === 'full' ? 'compact' : settings.layout, followTimer;
  const voiceLibrary = new Map((Array.isArray(settings.voiceLibrary) ? settings.voiceLibrary : []).map(parseVoice).filter(Boolean).map(v => [v.id, v]));
  const readingSettings = () => ({ ...settings, ...(settings.provider === 'local' ? {
    model: LOCAL_CONFIG.model, voiceReferenceId: hasLoadedVoices ? voiceLibrary.get(settings.voiceId)?.referenceId : undefined } : {}) });
  if (settings.voiceId && !voiceLibrary.has(settings.voiceId)) voiceLibrary.set(settings.voiceId, { id: settings.voiceId, name: settings.voiceName || 'Saved voice' });
  const report = error => { $('error').textContent = error.message; $('error').hidden = false; resize(); };
  const send = message => transport.request(message).catch(report);
  const resize = () => transport.request({ type: 'resize', height: $('player').scrollHeight + 4, layout: settings.layout }).catch(() => {});
  const save = async value => { Object.assign(settings, value); await transport.save(value); };
  const engine = new ReaderEngine({ audio: audio || $('audio'), generate, cache,
    onHighlight: value => send({ type: 'highlight', value }),
    onUpdate: state => {
      const labels = { idle: settings.voiceId ? 'Ready to listen' : 'Choose your voice in Settings',
        buffering: 'Preparing your voice…', playing: 'Reading · pitch preserved', paused: 'Paused',
        generating: 'Generating the article…', ended: 'Finished · play to listen again', error: 'Reading stopped' };
      $('status').textContent = labels[state.state];
      $('coverage').textContent = state.count ? `${state.generated}/${state.count} ready` : '';
      $('play').setAttribute('aria-label', state.state === 'playing' || state.state === 'buffering' ? 'Pause reading' : 'Play article');
      $('play-icon').textContent = state.state === 'playing' || state.state === 'buffering' ? 'Ⅱ' : '▶';
      $('elapsed').textContent = time(state.position / state.speed);
      $('duration').textContent = state.duration ? `${time(state.duration / state.speed)}${state.complete ? '' : ' buffered'}` : 'Ready to listen';
      $('seek').disabled = !state.seekableDuration;
      $('seek').max = String(state.seekableDuration || 1);
      if (document.activeElement !== $('seek')) $('seek').value = String(state.position);
      $('download').disabled = !state.complete;
      $('previous').disabled = !state.count || state.index === 0;
      $('next').disabled = !state.count || state.index === state.count - 1;
      if (state.error) report(new Error(state.error));
      // A visible diagnostic surface is useful for accessibility and browser QA.
      document.body.dataset.state = state.state;
      document.body.dataset.word = state.word;
      document.body.dataset.speed = String(state.speed);
    } });
  const preview = new ReaderEngine({ generate, cache,
    onUpdate: state => {
      const busy = ['playing', 'buffering'].includes(state.state);
      $('preview-voice').textContent = busy ? '■ Stop preview' : '▶ Preview voice';
      if (state.error) report(new Error(state.error));
    } });
  function reload() {
    if (article) engine.load(settings.provider === 'local'
      ? { ...article, passages: splitPassages(article.blocks.map(text => ({ text })), 160) } : article, readingSettings());
  }
  function setLayout(layout, persist = true) {
    if (!['minimal', 'compact', 'full'].includes(layout)) return;
    if (layout !== 'full') previousView = layout;
    settings.layout = layout; document.body.dataset.layout = layout;
    for (const button of document.querySelectorAll('.view-switcher button')) button.setAttribute('aria-pressed', String(button.dataset.layout === layout));
    $('settings').hidden = layout !== 'full';
    $('settings-toggle').setAttribute('aria-expanded', String(layout === 'full'));
    $('settings-toggle').textContent = layout === 'full' ? 'Hide settings' : 'Settings';
    if (persist) save({ layout });
    resize();
    if (layout === 'full' && !hasLoadedVoices) refreshVoices();
  }
  function toggleSettings(open = $('settings').hidden) { setLayout(open ? 'full' : previousView); }
  function renderVoices() {
    $('voice').replaceChildren(new Option('Choose a voice', ''), ...visibleVoices.map(v => new Option(v.name, v.id)));
    $('voice').value = settings.voiceId || '';
    $('voice-description').textContent = voiceLibrary.get(settings.voiceId)?.description || 'Choose a voice to make it yours.';
    $('voice-results').textContent = visibleVoices.length ? `${visibleVoices.length} voices` : 'No voices available';
    $('preview-voice').disabled = !canGenerate(readingSettings()); resize();
  }
  async function refreshVoices() {
    voiceAbort?.abort(); const controller = voiceAbort = new AbortController();
    $('voice-results').textContent = 'Loading voices…'; $('retry-voices').hidden = true;
    try {
      const previousReference = readingSettings().voiceReferenceId;
      const result = await loadVoices(settings.apiKey, { provider: settings.provider, signal: controller.signal });
      if (controller.signal.aborted) return;
      visibleVoices = result.voices.map(parseVoice).filter(Boolean);
      voiceLibrary.clear(); for (const voice of visibleVoices) voiceLibrary.set(voice.id, voice);
      hasLoadedVoices = true;
      await save({ voiceLibrary: [...voiceLibrary.values()] });
      renderVoices();
      if (!voiceLibrary.has(settings.voiceId) && visibleVoices.length) { $('voice').value = visibleVoices[0].id; await chooseVoice(); }
      else if (previousReference !== readingSettings().voiceReferenceId) reload();
      $('error').hidden = true; resize();
    } catch (error) {
      if (error.name !== 'AbortError') { $('voice-results').textContent = 'Could not load voices'; $('retry-voices').hidden = false; report(error); }
    }
  }
  async function chooseVoice() {
    const voice = voiceLibrary.get($('voice').value);
    if (!voice) return;
    preview.stop();
    const saving = save({ voiceId: voice.id, voiceName: voice.name });
    renderVoices(); reload(); await saving;
  }
  for (const option of $('language').options) option.disabled = settings.provider === 'local' && !!option.value && !LOCAL_CONFIG.languages[option.value];
  for (const button of document.querySelectorAll('.view-switcher button')) button.onclick = () => setLayout(button.dataset.layout);
  $('settings-toggle').onclick = () => toggleSettings();
  $('close').onclick = () => { clearInterval(followTimer); unsubscribe(); voiceAbort?.abort(); preview.stop(); engine.stop(); send({ type: 'close' }); };
  $('play').onclick = async () => {
    $('error').hidden = true;
    if (engine.wantsPlay) { engine.pause(); return; }
    preview.stop();
    if (!canGenerate(readingSettings()) && !engine.segments[engine.index]?.result) { toggleSettings(true); report(new Error('Choose a voice in Settings first.')); return; }
    await engine.play();
  };
  $('stop').onclick = () => { preview.stop(); engine.stop(); };
  $('previous').onclick = () => engine.go(Math.max(0, engine.index - 1));
  $('next').onclick = () => engine.go(Math.min(engine.segments.length - 1, engine.index + 1));
  $('speed').value = String(settings.speed);
  $('speed').onchange = async () => { engine.setSpeed($('speed').value); await save({ speed: engine.speed }); };
  $('follow').checked = settings.follow;
  $('follow').onchange = async () => { showFollowPause(0); const saving = save({ follow: $('follow').checked }); send({ type: 'follow', value: settings.follow }); await saving; };
  $('seek').onchange = () => engine.seek(Number($('seek').value));
  $('retry-voices').onclick = () => refreshVoices();
  $('voice').onchange = chooseVoice;
  $('preview-voice').onclick = async () => {
    if (preview.wantsPlay) { preview.stop(); return; }
    if (engine.wantsPlay) engine.pause();
    preview.load({ title: 'Voice preview', url: '', blocks: [PREVIEW_TEXT],
      passages: [{ block: 0, offset: 0, text: PREVIEW_TEXT }] }, { ...readingSettings(), speed: 1, mode: 'stream' });
    await preview.play();
  };
  for (const id of ['language', 'mode']) {
    $(id).value = settings[id] || '';
    $(id).onchange = async () => { preview.stop(); const saving = save({ [id]: $(id).value }); reload(); await saving; };
  }
  $('download').onclick = async () => {
    try {
      const blob = await engine.exportWav(), url = URL.createObjectURL(blob);
      const link = document.createElement('a'); link.href = url;
      link.download = `${(article.title || 'article').replace(/[^\p{L}\p{N} ._-]/gu, '').slice(0, 100)}.wav`;
      link.click(); setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (error) { report(error); }
  };
  $('clear-cache').onclick = async () => { await (cache || audioCache).clear(); $('voice-results').textContent = 'Saved audio cleared'; };
  $('open-recording').onclick = () => $('recording-file').click();
  $('recording-file').onchange = async () => {
    const file = $('recording-file').files[0];
    if (!file) return;
    try { await engine.openRecording(file); $('error').hidden = true; toggleSettings(false); }
    catch (error) { report(error); }
    $('recording-file').value = '';
  };
  document.addEventListener('keydown', event => {
    if (event.code === 'Space' && !['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(event.target.tagName)) {
      event.preventDefault(); $('play').click();
    }
  });
  function showFollowPause(until) {
    clearInterval(followTimer);
    const update = () => {
      const seconds = Math.max(0, Math.ceil((until - Date.now()) / 1000));
      $('follow-status').hidden = !seconds || !settings.follow;
      $('follow-status').textContent = seconds ? `Scroll paused · ${seconds}s` : '';
      if (!seconds) clearInterval(followTimer);
    };
    update(); if (until > Date.now()) followTimer = setInterval(update, 250);
  }
  try {
    unsubscribe = await transport.subscribe(async position => {
      if (position.type === 'follow-state') { showFollowPause(position.pausedUntil); return; }
      try {
        if (!canGenerate(readingSettings()) && !engine.segments.every(segment => segment.result)) {
          toggleSettings(true); throw new Error('Choose a voice in Settings first.');
        }
        $('error').hidden = true; preview.stop();
        await engine.seekWord(position);
      } catch (error) { report(error); }
    });
    // Load current reference identities before looking up cached local audio.
    if (settings.provider === 'local') await refreshVoices();
    article = await transport.request({ type: 'article' });
    $('title').textContent = article.title; $('title').title = article.title;
    reload(); await send({ type: 'follow', value: settings.follow });
    if (settings.voiceId) {
      visibleVoices = [...voiceLibrary.values()]; renderVoices();
    } else toggleSettings(true);
  } catch (error) { $('title').textContent = 'Open a readable article'; report(error); }
  setLayout(settings.layout, false);
  new ResizeObserver(resize).observe($('player')); resize();
  window.addEventListener('pagehide', () => { clearInterval(followTimer); unsubscribe(); voiceAbort?.abort(); preview.stop(); engine.stop(); }, { once: true });
  return { engine, preview, getSettings: readingSettings, resize };
}

if (typeof chrome !== 'undefined' && chrome.runtime?.id) startPlayer();
