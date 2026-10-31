import { ReaderEngine } from './engine.js';
import { canGenerate, providerVoices, normalizeProviderSettings } from './providers.js';
import { LOCAL_CONFIG } from './local.js';
import { audioCache } from './cache.js';
import { bridge } from './bridge.js';
import { parseVoice, voiceLabel, voiceSearch, VOICE_STYLES, PREVIEW_TEXT } from './voices.js';

export async function startPlayer({ transport = bridge, generate, cache, audio, loadVoices = providerVoices } = {}) {
  const $ = id => document.getElementById(id);
  const time = value => `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, '0')}`;
  const savedSettings = { provider: 'cartesia', speed: 1, model: 'sonic-3.6', mode: 'stream', follow: true, ...await transport.settings() };
  let article, settings = normalizeProviderSettings(savedSettings);
  if (settings !== savedSettings) await transport.save(settings);
  if (settings.provider === 'local') settings.model = LOCAL_CONFIG.model;
  let cursor = null, voiceAbort, hasLoadedVoices = false, visibleVoices = [], unsubscribe = () => {};
  const voiceLibrary = new Map((Array.isArray(settings.voiceLibrary) ? settings.voiceLibrary : []).map(parseVoice).filter(Boolean).map(v => [v.id, v]));
  const readingSettings = () => ({ ...settings, ...(settings.provider === 'local' ? {
    model: LOCAL_CONFIG.model, voiceReferenceId: hasLoadedVoices ? voiceLibrary.get(settings.voiceId)?.referenceId : undefined } : {}) });
  if (settings.voiceId && !voiceLibrary.has(settings.voiceId)) voiceLibrary.set(settings.voiceId, { id: settings.voiceId, name: settings.voiceName || 'Saved voice' });
  const report = error => { $('error').textContent = error.message; $('error').hidden = false; resize(); };
  const send = message => transport.request(message).catch(report);
  const resize = () => transport.request({ type: 'resize', height: $('player').scrollHeight + 4 }).catch(() => {});
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
      $('duration').textContent = state.duration ? `${time(state.duration / state.speed)}${state.complete ? '' : ' buffered'}` : 'Generate to see duration';
      $('seek').disabled = !state.seekableDuration;
      $('seek').max = String(state.seekableDuration || 1);
      if (document.activeElement !== $('seek')) $('seek').value = String(state.position);
      $('download').disabled = !state.complete;
      $('prepare').disabled = state.complete || state.state === 'generating';
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
  $('voice-style').replaceChildren(...VOICE_STYLES.map(item => new Option(item.name, item.id)));
  function reload() { if (article) engine.load(article, readingSettings()); }
  function toggleSettings(open = $('settings').hidden) {
    $('settings').hidden = !open; $('settings-toggle').setAttribute('aria-expanded', String(open)); resize();
    if (open && (settings.provider === 'local' || settings.apiKey) && !hasLoadedVoices) refreshVoices();
  }
  function renderVoices() {
    const options = [new Option('Choose a voice', '')];
    if (settings.voiceId && !visibleVoices.some(v => v.id === settings.voiceId)) {
      const current = document.createElement('optgroup'); current.label = 'Current voice';
      current.append(new Option(voiceLabel(voiceLibrary.get(settings.voiceId)), settings.voiceId)); options.push(current);
    }
    if (visibleVoices.length) {
      const group = document.createElement('optgroup'); group.label = 'Available voices';
      group.append(...visibleVoices.map(v => new Option(voiceLabel(v), v.id))); options.push(group);
    }
    $('voice').replaceChildren(...options); $('voice').value = settings.voiceId || '';
    $('voice-description').textContent = voiceLibrary.get(settings.voiceId)?.description || voiceLibrary.get(settings.voiceId)?.tagline || 'Browse by voice type, style or language.';
    $('voice-results').textContent = visibleVoices.length ? `${visibleVoices.length} voice${visibleVoices.length === 1 ? '' : 's'}${cursor ? ' · more available' : ''}` : 'No matching voices';
    $('preview-voice').disabled = !canGenerate(readingSettings());
    $('more-voices').hidden = !cursor; resize();
  }
  async function refreshVoices(append = false) {
    if (settings.provider !== 'local' && !settings.apiKey && !$('api-key').value.trim()) { report(new Error('Add your Cartesia API key first.')); return; }
    voiceAbort?.abort(); const controller = voiceAbort = new AbortController();
    const key = $('api-key').value.trim() || settings.apiKey;
    $('connect').disabled = true; $('voice-results').textContent = 'Loading voices…';
    try {
      const previousReference = readingSettings().voiceReferenceId;
      const result = await loadVoices(key, { provider: settings.provider, query: voiceSearch($('voice-style').value, $('voice-search').value),
        gender: $('voice-gender').value, language: settings.language || '', cursor: append ? cursor : '', signal: controller.signal });
      if (controller.signal.aborted) return;
      const voices = result.voices.map(parseVoice).filter(Boolean);
      visibleVoices = [...new Map([...(append ? visibleVoices : []), ...voices].map(v => [v.id, v])).values()];
      for (const voice of voices) voiceLibrary.set(voice.id, voice);
      cursor = result.cursor; hasLoadedVoices = true;
      const keyChanged = settings.provider !== 'local' && settings.apiKey !== key;
      await save({ ...(settings.provider === 'local' ? {} : { apiKey: key }), voiceLibrary: [...voiceLibrary.values()].slice(-200) });
      if (settings.provider !== 'local' && !$('api-key').disabled) { $('api-key').value = ''; $('api-key').placeholder = 'Key saved on this device'; }
      renderVoices();
      if (!settings.voiceId && voices.length) { $('voice').value = voices[0].id; await chooseVoice(); }
      else if (keyChanged || previousReference !== readingSettings().voiceReferenceId) reload();
      $('voice-name').textContent = settings.voiceName || 'Connected';
      $('error').hidden = true; resize();
    } catch (error) { if (error.name !== 'AbortError') { $('voice-results').textContent = 'Could not load voices'; report(error); } }
    finally { if (voiceAbort === controller) $('connect').disabled = false; }
  }
  async function chooseVoice() {
    const voice = voiceLibrary.get($('voice').value);
    if (!voice) return;
    preview.stop();
    await save({ voiceId: voice.id, voiceName: voice.name });
    $('voice-name').textContent = settings.voiceName; renderVoices(); reload();
  }
  function providerUI() {
    const local = settings.provider === 'local';
    $('provider').value = settings.provider;
    document.querySelector('.provider').textContent = local ? 'QWEN · LOCAL' : 'CARTESIA';
    $('cartesia-connection').hidden = local; $('local-connection').hidden = !local;
    $('forget-key').hidden = local;
    $('voice').setAttribute('aria-label', 'Reading voice');
    $('model').replaceChildren(...(local ? [new Option('Qwen3-TTS 1.7B · fixed reference', LOCAL_CONFIG.model)]
      : [new Option('Sonic 3.6', 'sonic-3.6'), new Option('Sonic 3.5', 'sonic-3.5'), new Option('Sonic 3', 'sonic-3')]));
    $('model').value = settings.model; $('model').disabled = local;
    for (const option of $('language').options) option.disabled = local && !!option.value && !LOCAL_CONFIG.languages[option.value];
  }
  $('provider').onchange = async () => {
    voiceAbort?.abort(); preview.stop(); engine.stop();
    const profiles = { ...settings.providerProfiles, [settings.provider]: {
      voiceId: settings.voiceId || '', voiceName: settings.voiceName || '', model: settings.model,
      voiceLibrary: [...voiceLibrary.values()] } };
    const provider = $('provider').value;
    const profile = profiles[provider] || { voiceId: '', voiceName: '', voiceLibrary: [],
      model: provider === 'local' ? LOCAL_CONFIG.model : 'sonic-3.6' };
    await save({ provider, providerProfiles: profiles, ...profile, model: provider === 'local' ? LOCAL_CONFIG.model : profile.model,
      ...(provider === 'local' && settings.language && !LOCAL_CONFIG.languages[settings.language] ? { language: '' } : {}) });
    $('language').value = settings.language || ''; $('api-key').value = '';
    voiceLibrary.clear(); for (const voice of profile.voiceLibrary) voiceLibrary.set(voice.id, voice);
    visibleVoices = [...voiceLibrary.values()]; cursor = null; hasLoadedVoices = false;
    $('voice-search').value = ''; $('voice-gender').value = ''; $('voice-style').value = '';
    providerUI(); renderVoices(); reload();
    $('voice-name').textContent = settings.voiceName || 'Choose a voice'; $('error').hidden = true;
    await refreshVoices();
  };
  providerUI();
  $('settings-toggle').onclick = () => toggleSettings();
  $('close').onclick = () => { unsubscribe(); voiceAbort?.abort(); preview.stop(); engine.stop(); send({ type: 'close' }); };
  $('play').onclick = async () => {
    $('error').hidden = true;
    if (engine.wantsPlay) { engine.pause(); return; }
    preview.stop();
    if (!canGenerate(readingSettings()) && !engine.segments[engine.index]?.result) { toggleSettings(true); report(new Error('Connect your voice provider and choose a voice first.')); return; }
    await engine.play();
  };
  $('stop').onclick = () => { preview.stop(); engine.stop(); };
  $('previous').onclick = () => engine.go(Math.max(0, engine.index - 1));
  $('next').onclick = () => engine.go(Math.min(engine.segments.length - 1, engine.index + 1));
  $('speed').value = String(settings.speed);
  $('speed').onchange = async () => { engine.setSpeed($('speed').value); await save({ speed: engine.speed }); };
  $('follow').checked = settings.follow;
  $('follow').onchange = async () => { await save({ follow: $('follow').checked }); send({ type: 'follow', value: settings.follow }); };
  $('seek').onchange = () => engine.seek(Number($('seek').value));
  $('connect').onclick = () => refreshVoices();
  $('connect-local').onclick = () => refreshVoices();
  $('search-voices').onclick = () => refreshVoices();
  $('voice-search').onkeydown = event => { if (event.key === 'Enter') refreshVoices(); };
  $('more-voices').onclick = () => refreshVoices(true);
  $('voice-gender').onchange = () => refreshVoices();
  $('voice-style').onchange = () => refreshVoices();
  $('voice').onchange = chooseVoice;
  $('preview-voice').onclick = async () => {
    if (preview.wantsPlay) { preview.stop(); return; }
    if (engine.wantsPlay) engine.pause();
    preview.load({ title: 'Voice preview', url: '', blocks: [PREVIEW_TEXT],
      passages: [{ block: 0, offset: 0, text: PREVIEW_TEXT }] }, { ...readingSettings(), speed: 1, mode: 'stream' });
    await preview.play();
  };
  for (const id of ['model', 'language', 'mode']) {
    $(id).value = settings[id] || '';
    $(id).onchange = async () => { preview.stop(); await save({ [id]: $(id).value }); reload(); if (id === 'language' && (settings.provider === 'local' || settings.apiKey)) refreshVoices(); };
  }
  $('prepare').onclick = () => {
    if (!canGenerate(readingSettings())) { toggleSettings(true); report(new Error('Connect your voice provider and choose a voice first.')); return; }
    engine.prepareAll();
  };
  $('download').onclick = async () => {
    try {
      const blob = await engine.exportWav(), url = URL.createObjectURL(blob);
      const link = document.createElement('a'); link.href = url;
      link.download = `${(article.title || 'article').replace(/[^\p{L}\p{N} ._-]/gu, '').slice(0, 100)}.wav`;
      link.click(); setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (error) { report(error); }
  };
  $('clear-cache').onclick = async () => { await (cache || audioCache).clear(); $('voice-name').textContent = 'Saved audio cleared'; };
  $('open-recording').onclick = () => $('recording-file').click();
  $('recording-file').onchange = async () => {
    const file = $('recording-file').files[0];
    if (!file) return;
    try { await engine.openRecording(file); $('error').hidden = true; toggleSettings(false); }
    catch (error) { report(error); }
    $('recording-file').value = '';
  };
  $('forget-key').onclick = async () => {
    voiceAbort?.abort(); preview.stop(); engine.stop();
    await save({ apiKey: '', voiceId: '', voiceName: '', voiceLibrary: [] });
    visibleVoices = []; voiceLibrary.clear(); cursor = null; hasLoadedVoices = false;
    $('api-key').value = ''; $('api-key').placeholder = 'Paste your API key';
    renderVoices(); $('voice-name').textContent = 'Key removed'; reload();
  };
  document.addEventListener('keydown', event => {
    if (event.code === 'Space' && !['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(event.target.tagName)) {
      event.preventDefault(); $('play').click();
    }
  });
  try {
    unsubscribe = await transport.subscribe(async position => {
      try {
        if (!canGenerate(readingSettings()) && !engine.segments.every(segment => segment.result)) {
          toggleSettings(true); throw new Error('Connect your voice provider and choose a voice first.');
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
      $('voice-name').textContent = settings.voiceName || 'Connected';
      $('api-key').placeholder = 'Key saved on this device';
    } else toggleSettings(true);
  } catch (error) { $('title').textContent = 'Open a readable article'; report(error); }
  new ResizeObserver(resize).observe($('player')); resize();
  window.addEventListener('pagehide', () => { unsubscribe(); voiceAbort?.abort(); preview.stop(); engine.stop(); }, { once: true });
  return { engine, preview, getSettings: readingSettings, resize };
}

if (typeof chrome !== 'undefined' && chrome.runtime?.id) startPlayer();
