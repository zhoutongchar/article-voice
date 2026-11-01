import { pcmWav } from './cartesia.js';
import { generateSpeech } from './providers.js';
import { alignWords, wordAtPosition, sourceSpan } from './alignment.js';
import { audioCache, cacheKey } from './cache.js';
import { readRecording } from './recording.js';
import { prepareReadingUnit } from './reading-preparation.js';

export class ReaderEngine {
  constructor({ audio = new Audio(), generate = generateSpeech, prepare = prepareReadingUnit, cache = audioCache, onUpdate = () => {}, onHighlight = () => {} } = {}) {
    Object.assign(this, { audio, generate, prepare, cache, onUpdate, onHighlight });
    this.speed = 1; this.state = 'idle'; this.segments = []; this.index = 0;
    this.audio.preservesPitch = true;
    this.audio.addEventListener('ended', () => this.next());
    this.audio.addEventListener('error', () => this.fail(new Error('Audio playback failed. Try another passage.')));
    this.audio.addEventListener('timeupdate', () => this.tick());
    this.audio.addEventListener('seeked', () => this.tick());
    this.audio.addEventListener('playing', () => { if (this.wantsPlay) { this.state = 'playing'; this.emit(); } });
    this.audio.addEventListener('waiting', () => { if (this.wantsPlay) { this.state = 'buffering'; this.emit(); } });
    this.controller = new AbortController(); this.epoch = 0; this.loadVersion = 0;
  }
  load(article, settings, prepared = []) {
    this.stop(); this.loadVersion++;
    this.article = article; this.settings = { ...settings };
    this.needsPreparation = settings.provider === 'local' && article.source?.format === 'ocr' && !article.preparation;
    this.preparing = null;
    this.segments = article.passages.map((item, index) => {
      const prior = prepared[index];
      return { ...item, ...(prior?.text === item.text && prior.block === item.block && prior.offset === item.offset ? { result: prior.result } : {}) };
    });
    if (this.needsPreparation) this.segments = [];
    this.index = 0; this.loadedIndex = -1; this.bytes = this.segments.reduce((sum, segment) => sum + (segment.result?.pcm.byteLength || 0), 0); this.error = '';
    this.setSpeed(settings.speed || 1); this.emit();
  }
  async prepareSource() {
    if (!this.needsPreparation) return;
    const signal = this.controller.signal, version = this.loadVersion;
    if (!this.preparing || this.preparing.signal.aborted) {
      const pending = this.prepare(this.article, this.settings, signal).then(article => {
        if (signal.aborted || version !== this.loadVersion) throw new DOMException('Cancelled', 'AbortError');
        this.article = article; this.segments = article.passages.map(item => ({ ...item }));
        this.needsPreparation = false; this.emit();
      });
      this.preparing = { pending, signal };
      pending.catch(() => { if (this.preparing?.pending === pending) this.preparing = null; });
    }
    await this.preparing.pending;
  }
  emit() {
    const ready = this.segments.filter(s => s.result);
    const complete = ready.length === this.segments.length && !!ready.length;
    const before = this.segments.slice(0, this.index).reduce((sum, s) => sum + (s.result?.duration || 0), 0);
    let seekableDuration = 0;
    for (const segment of this.segments) { if (!segment.result) break; seekableDuration += segment.result.duration; }
    this.onUpdate({ state: this.state, speed: this.speed, index: this.index,
      count: this.segments.length, generated: ready.length, complete, error: this.error,
      preparingText: this.needsPreparation,
      duration: ready.reduce((sum, s) => sum + s.result.duration, 0), seekableDuration,
      position: before + (this.loadedIndex === this.index ? this.audio.currentTime || 0 : 0),
      word: this.lastWord || '', pitchPreserved: this.audio.preservesPitch });
  }
  setSpeed(value) {
    const speed = Number(value);
    if (!Number.isFinite(speed) || speed < 0.5 || speed > 3) throw new Error('Playback speed must be between 0.5× and 3×.');
    this.speed = speed; this.audio.playbackRate = speed; this.audio.defaultPlaybackRate = speed;
    this.emit();
  }
  async ensure(index) {
    await this.prepareSource();
    const segment = this.segments[index];
    if (!segment) return null;
    if (segment.result) return segment.result;
    if (segment.pending && !segment.pendingSignal.aborted) return segment.pending;
    const signal = this.controller.signal, version = this.loadVersion;
    const pending = (async () => {
      const key = await cacheKey(segment.text, this.settings);
      let result = await this.cache.get(key).catch(() => null);
      if (signal.aborted || version !== this.loadVersion) throw new DOMException('Cancelled', 'AbortError');
      if (!result) {
        result = await this.generate(segment.text, segment.preparation ? { ...this.settings, preparation: segment.preparation } : this.settings, signal);
        if (signal.aborted || version !== this.loadVersion) throw new DOMException('Cancelled', 'AbortError');
        await this.cache.set(key, result).catch(() => {}); // Cache failure must not prevent listening.
      }
      if (signal.aborted || version !== this.loadVersion) throw new DOMException('Cancelled', 'AbortError');
      if (this.bytes + result.pcm.byteLength > 128 * 1024 * 1024)
        throw new Error('This reading reached the 128 MB audio limit. Start a shorter selection or section.');
      this.bytes += result.pcm.byteLength;
      segment.result = { ...result, words: this.article.align ? this.article.align(segment, result.words) : alignWords(segment.text, result.words) };
      this.emit(); return segment.result;
    })().finally(() => { if (segment.pending === pending) segment.pending = null; });
    segment.pending = pending; segment.pendingSignal = signal;
    return pending;
  }
  async fill(ahead = false) {
    await this.prepareSource();
    const version = this.loadVersion;
    for (let i = ahead ? 0 : this.index; i < this.segments.length && (ahead || i <= this.index + 2); i++) {
      await this.ensure(i);
      if (version !== this.loadVersion || this.controller.signal.aborted) return;
    }
  }
  async play() {
    if (!this.segments.length && !this.needsPreparation) return;
    if (this.state === 'ended') { this.index = 0; this.loadedIndex = -1; }
    const epoch = ++this.epoch;
    this.wantsPlay = true; this.error = ''; this.state = 'buffering'; this.emit();
    try {
      await this.prepareSource();
      if (epoch !== this.epoch || !this.wantsPlay) return;
      if (this.settings.mode === 'ahead') await this.fill(true);
      const result = await this.ensure(this.index);
      if (epoch !== this.epoch || !this.wantsPlay) return;
      if (this.loadedIndex !== this.index) this.setAudio(result);
      this.audio.playbackRate = this.speed;
      await this.audio.play();
      if (epoch !== this.epoch || !this.wantsPlay) { this.audio.pause(); return; }
      this.state = 'playing'; this.emit(); this.animate();
      this.fill().catch(error => { if (error.name !== 'AbortError') { this.prefetchError = error; this.emit(); } });
    } catch (error) { if (epoch === this.epoch && error.name !== 'AbortError') this.fail(error); }
  }
  setAudio(result) {
    this.audio.pause();
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = URL.createObjectURL(pcmWav(result.pcm));
    this.audio.src = this.objectUrl; this.audio.playbackRate = this.speed;
    this.loadedIndex = this.index; this.lastHighlight = null;
  }
  pause() {
    this.wantsPlay = false; this.epoch++; this.audio.pause();
    cancelAnimationFrame(this.frame); this.state = 'paused'; this.emit();
  }
  stop() {
    this.wantsPlay = false; this.epoch++; this.controller.abort(); this.controller = new AbortController();
    this.audio.pause(); this.audio.removeAttribute('src'); this.audio.load();
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = null; this.index = 0; this.loadedIndex = -1;
    cancelAnimationFrame(this.frame); this.state = 'idle'; this.lastWord = ''; this.lastHighlight = null;
    this.onHighlight(null); this.emit();
  }
  async next() {
    if (!this.wantsPlay) return;
    if (this.index + 1 >= this.segments.length) {
      const epoch = this.epoch;
      if (this.onEnd) {
        try { if (await this.onEnd() || epoch !== this.epoch) return; }
        catch (error) { if (epoch === this.epoch && error.name !== 'AbortError') this.fail(error); return; }
      }
      this.wantsPlay = false; this.state = 'ended'; this.onHighlight(null); this.emit(); return;
    }
    this.index++; this.loadedIndex = -1; await this.play();
  }
  go(index, offset = 0) { return this.moveTo(index, () => offset, this.wantsPlay); }
  async moveTo(index, resolveTime, autoplay) {
    await this.prepareSource();
    if (!this.segments[index]) return;
    const epoch = ++this.epoch;
    this.wantsPlay = autoplay; cancelAnimationFrame(this.frame);
    this.audio.pause(); this.index = index; this.onHighlight(null);
    this.state = 'buffering'; this.emit();
    try {
      const result = await this.ensure(index);
      if (epoch !== this.epoch) return;
      const offset = resolveTime(result);
      if (this.loadedIndex !== index) this.setAudio(result);
      this.audio.currentTime = Math.max(0, Math.min(offset, result.duration - 0.01));
      this.tick(); this.state = 'paused'; this.emit();
      if (autoplay) await this.play();
    } catch (error) { if (epoch === this.epoch && error.name !== 'AbortError') this.fail(error); }
  }
  seekWord(position) {
    if (!Number.isInteger(position.block) || !Number.isInteger(position.start) || !Number.isInteger(position.end)
      || position.start < 0 || position.end <= position.start || position.end > (this.article?.blocks[position.block]?.length ?? 0))
      throw new Error('This word is no longer available. Reopen the reader.');
    return this.prepareSource().then(() => this.seekPreparedWord(position));
  }
  seekPreparedWord(position) {
    const matches = (segment, word) => {
      const spans = word.sources?.map(source => ({ block: source.block, start: source.from, end: source.to })) || [sourceSpan(segment, word)];
      return spans.some(span => span.block === position.block && span.start != null && position.start < span.end && position.end > span.start);
    };
    const index = this.segments.findIndex(segment => segment.result?.words.some(word => matches(segment, word))
      || (segment.sourceRanges || [{ block: segment.block, start: segment.offset, end: segment.offset + segment.text.length }])
        .some(range => range.block === position.block && position.start < range.end && position.end > range.start));
    if (index < 0) throw new Error('No audio passage is available for this word.');
    return this.moveTo(index, result => {
      const word = result.words.find(word => matches(this.segments[index], word));
      if (!word) throw new Error('No word timing is available for that word. Try another word.');
      return word.start;
    }, true);
  }
  seek(seconds) {
    let position = 0;
    for (let i = 0; i < this.segments.length; i++) {
      const duration = this.segments[i].result?.duration;
      if (duration == null) return;
      if (position + duration > seconds || i === this.segments.length - 1) return this.go(i, Math.max(0, seconds - position));
      position += duration;
    }
  }
  animate() {
    cancelAnimationFrame(this.frame);
    const step = () => { if (!this.wantsPlay) return; this.tick(); this.frame = requestAnimationFrame(step); };
    this.frame = requestAnimationFrame(step);
  }
  tick() {
    const segment = this.segments[this.index];
    const readable = this.loadedIndex === this.index && !['idle', 'ended', 'error'].includes(this.state) && segment?.result;
    const word = readable ? wordAtPosition(segment.result.words, this.audio.currentTime || 0) : null;
    const key = readable ? `${this.index}:${word?.start ?? 'passage'}` : '';
    if (key !== this.lastHighlight) {
      this.lastHighlight = key; this.lastWord = word?.word || '';
      this.onHighlight(readable ? { ...(word ? sourceSpan(segment, word) : { block: segment.block, start: null, end: null }),
        word: word?.word || '' } : null);
    }
    this.emit();
  }
  fail(error) {
    this.wantsPlay = false; this.audio.pause(); cancelAnimationFrame(this.frame);
    this.error = error.message; this.state = 'error'; this.onHighlight(null); this.emit();
  }
  async prepareAll() {
    this.error = ''; const old = this.state;
    if (!this.wantsPlay) this.state = 'generating'; this.emit();
    try { await this.fill(true); if (this.state === 'generating') this.state = old === 'ended' ? 'ended' : 'paused'; this.emit(); }
    catch (error) { if (error.name !== 'AbortError') this.fail(error); }
  }
  async exportWav() {
    if (!this.segments.every(s => s.result)) throw new Error('Generate the complete article before downloading.');
    const pcm = new Uint8Array(this.bytes), words = [];
    let bytes = 0, time = 0;
    for (const segment of this.segments) {
      pcm.set(segment.result.pcm, bytes); bytes += segment.result.pcm.length;
      words.push(...segment.result.words.map(word => {
        const span = sourceSpan(segment, word);
        return { ...word, start: word.start + time, end: word.end + time,
          block: span.block, from: span.start, to: span.end };
      }));
      time += segment.result.duration;
    }
    return pcmWav(pcm, undefined, { version: 1, title: this.article.title, url: this.article.url,
      blocks: this.article.blocks, words });
  }
  async openRecording(blob) {
    const version = this.loadVersion, recording = await readRecording(blob, this.article);
    if (version !== this.loadVersion) return;
    this.stop(); this.loadVersion++;
    this.segments = [{ text: this.article.blocks.join('\n'), block: 0, offset: 0, result: recording }];
    this.bytes = recording.pcm.length; this.state = 'paused'; this.error = ''; this.emit();
  }
}
