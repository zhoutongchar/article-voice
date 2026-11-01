import { ReaderEngine } from './engine.js';
import { splitPassages } from './article.js';
import { WorkQueue } from './work-queue.js';

// The shared session handles ordered units, speech preparation and transitions.
// It has no site selectors, OCR rules, or page-navigation code.
export class ReadingSession {
  constructor({ engine, transport, onChange = () => {}, onError = () => {}, createAudio = () => new Audio() }) {
    Object.assign(this, { engine, transport, onChange, onError, createAudio });
    this.future = new Map(); this.version = 0; this.settling = Promise.resolve();
    const generate = engine.generate, queue = new WorkQueue();
    this.generate = (text, settings, signal, priority) => queue.run(() => generate(text, settings, signal), signal, priority);
    engine.generate = (text, settings, signal) => this.generate(text, settings, signal, 0);
    engine.onEnd = () => this.advance();
  }
  normalized(unit) {
    return this.settings.provider === 'local' ? { ...unit, passages: splitPassages(unit.blocks.map(text => ({ text })), 160) } : unit;
  }
  emit() { this.onChange({ queued: [...this.future.values()].filter(record => record.ready).length, preparing: !!this.pending, unit: this.unit }); }
  load(unit, settings) {
    this.unavailable = false;
    this.version++; this.settings = { ...settings }; this.wantsPlay = false;
    this.abortFuture(); this.endAfter = null;
    this.unit = unit; this.engine.load(this.normalized(unit), this.settings);
    this.settling = unit.source?.prefetch ? this.cancelSource(this.version) : Promise.resolve();
    this.settling.catch(this.onError);
    this.emit();
  }
  abortFuture() { for (const record of this.future.values()) record.engine.stop(); this.future.clear(); this.pending = null; }
  async cancelSource(version) {
    const actual = await this.transport.request({ type: 'source-cancel' });
    if (version === this.version && actual && actual.id !== this.unit?.id) {
      this.unit = actual; this.engine.load(this.normalized(actual), this.settings); this.emit();
    }
  }
  async play() {
    if (this.unavailable) throw new Error('The page changed. Close the player and reopen it at your reading position.');
    const version = this.version;
    await this.settling;
    if (version !== this.version || this.unavailable) return;
    this.wantsPlay = true;
    this.prefetch(); await this.engine.play();
  }
  pause() { this.wantsPlay = false; this.engine.pause(); }
  invalidate() { this.stop(); this.unavailable = true; }
  stop() {
    const version = ++this.version; this.wantsPlay = false; this.abortFuture(); this.engine.stop();
    this.settling = this.unit?.source?.prefetch ? this.cancelSource(version) : Promise.resolve();
    this.settling.catch(this.onError); this.emit(); return this.settling;
  }
  observe(state) {
    if (state.state === 'playing') { this.wantsPlay = true; this.prefetch(); }
    if (['paused', 'idle', 'error', 'ended'].includes(state.state)) this.wantsPlay = false;
  }
  prefetch() {
    if (!this.unit?.source?.prefetch || this.pending || this.future.size >= 2 || this.endAfter || !this.wantsPlay) return;
    const version = this.version, after = this.unit.id;
    const discovered = this.transport.request({ type: 'source-next', after }).then(units => {
      if (version !== this.version) return;
      if (units.length < 2) this.endAfter = units.at(-1)?.id || after;
      for (const unit of units) if (!this.future.has(unit.id)) {
        const record = { unit, ready: false, promoted: false };
        record.engine = new ReaderEngine({ audio: this.createAudio(), cache: this.engine.cache,
          generate: (text, settings, signal) => this.generate(text, settings, signal, record.promoted ? 0 : 1) });
        record.engine.load(this.normalized(unit), this.settings); this.future.set(unit.id, record);
      }
    }).catch(error => {
      if (version === this.version && error.name !== 'AbortError') { this.invalidate(); this.onError(error); }
      throw error;
    });
    this.discovered = discovered;
    const pending = discovered.then(async () => {
      if (version !== this.version) return;
      for (const record of this.future.values()) {
        for (let i = 0; i < record.engine.segments.length; i++) {
          await record.engine.ensure(i);
          if (version !== this.version) return;
          const bytes = this.engine.bytes + [...this.future.values()].reduce((sum, value) => sum + value.engine.bytes, 0);
          if (bytes > 128 * 1024 * 1024) throw new Error('The reading queue reached its audio limit. Stop and start a new reading here.');
        }
        record.ready = true; this.emit();
      }
    }).catch(error => {
      if (version === this.version && error.name !== 'AbortError') { this.pause(); this.onError(error); }
    }).finally(() => {
      if (this.pending === pending) { this.pending = null; this.emit(); }
    });
    this.pending = pending; this.emit();
  }
  async advance() {
    if (!this.unit?.source?.pagination) return false;
    const version = this.version;
    this.prefetch(); await this.discovered;
    if (version !== this.version || !this.wantsPlay) return false;
    const record = this.future.values().next().value;
    if (!record) return false;
    record.promoted = true;
    await record.engine.fill(true);
    if (version !== this.version || !this.wantsPlay) return false;
    const unit = await this.transport.request({ type: 'source-present', id: record.unit.id });
    if (version !== this.version) return false;
    const autoplay = this.wantsPlay;
    this.settings.speed = this.engine.speed;
    this.unit = unit; this.future.delete(unit.id);
    this.engine.load(this.normalized(unit), this.settings, record.engine.segments);
    this.emit();
    if (autoplay) { this.wantsPlay = true; await this.engine.play(); }
    else this.engine.pause();
    return true;
  }
}
