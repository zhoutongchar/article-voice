import { ReaderEngine } from './engine.js';
import { splitPassages } from './article.js';
import { WorkQueue } from './work-queue.js';
import { continuousUnit, fullyConsumed, needsContinuation } from './continuous-text.js';

// The shared session handles ordered units, speech preparation and transitions.
// It has no site selectors, OCR rules, or page-navigation code.
export class ReadingSession {
  constructor({ engine, transport, onChange = () => {}, onError = () => {}, createAudio = () => new Audio() }) {
    Object.assign(this, { engine, transport, onChange, onError, createAudio });
    this.future = new Map(); this.version = 0; this.settling = Promise.resolve();
    this.consumed = new Map();
    this.discoveries = new Map();
    const highlight = engine.onHighlight;
    engine.onHighlight = value => this.highlight(value, highlight);
    const generate = engine.generate, prepare = engine.prepare, queue = new WorkQueue();
    this.generate = (text, settings, signal, priority) => queue.run(() => generate(text, settings, signal), signal, priority);
    this.prepare = async (unit, settings, signal, priority) => {
      if (settings.provider === 'local' && unit.source?.format === 'ocr' && !unit.locations) {
        if (!this.discovered) this.prefetch(true);
        await this.discovered;
        if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
        let ordered = [this.unit, ...[...this.future.values()].map(record => record.unit)];
        if (ordered.at(-1).id === unit.id && unit.id !== this.endAfter && this.future.size < 2) {
          await this.discover(unit.id, 1, this.version);
          if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
          ordered = [this.unit, ...[...this.future.values()].map(record => record.unit)];
        }
        const index = ordered.findIndex(page => page.id === unit.id);
        unit = continuousUnit(unit, ordered.slice(index + 1), this.consumed);
        if (needsContinuation(unit) && ordered.length > index + 1 && this.future.size < 2 && ordered.at(-1).id !== this.endAfter) {
          await this.discover(ordered.at(-1).id, 1, this.version);
          if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
          ordered = [this.unit, ...[...this.future.values()].map(record => record.unit)];
          // Rebuild from the original page, extending only the uncommitted tail.
          unit = continuousUnit(ordered[index], ordered.slice(index + 1), this.consumed);
        }
      }
      return queue.run(() => prepare(unit, settings, signal), signal, priority);
    };
    engine.generate = (text, settings, signal) => this.generate(text, settings, signal, 0);
    engine.prepare = (unit, settings, signal) => this.prepare(unit, settings, signal, 0);
    engine.onEnd = () => this.advance();
  }
  normalized(unit) {
    return this.settings.provider === 'local' ? { ...unit, passages: splitPassages(unit.blocks.map(text => ({ text })), 160) } : unit;
  }
  emit() { this.onChange({ queued: [...this.future.values()].filter(record => record.ready).length, preparing: !!this.pending, unit: this.unit }); }
  load(unit, settings) {
    this.unavailable = false; this.needsRefresh = false;
    this.version++; this.settings = { ...settings }; this.wantsPlay = false;
    this.abortFuture(); this.endAfter = null;
    this.unit = unit; this.engine.load(this.normalized(unit), this.settings);
    this.displayed = unit.id; this.consumed.clear(); this.discovered = null;
    this.settling = unit.source?.prefetch ? this.cancelSource(this.version) : Promise.resolve();
    this.settling.catch(this.onError);
    this.emit();
  }
  abortFuture() { for (const record of this.future.values()) record.engine.stop(); this.future.clear(); this.pending = null; }
  async cancelSource(version) {
    const actual = await this.transport.request({ type: 'source-cancel' });
    if (version === this.version && actual && actual.id !== this.unit?.id) {
      this.unit = actual; this.displayed = actual.id; this.consumed.clear(); this.discovered = null; this.endAfter = null;
      this.engine.load(this.normalized(actual), this.settings); this.emit();
    }
  }
  async play() {
    if (this.needsRefresh) return this.reopen(true);
    if (this.unavailable) throw this.unavailable;
    const version = this.version;
    await this.settling;
    if (version !== this.version || this.unavailable) return;
    this.wantsPlay = true;
    this.prefetch(); await this.engine.play();
  }
  pause() { this.wantsPlay = false; if (this.needsRefresh) this.version++; this.engine.pause(); }
  async reopen(autoplay = this.wantsPlay) {
    const settling = this.stop(), version = this.version;
    this.needsRefresh = true;
    try {
      await settling;
      if (version !== this.version) return;
      const unit = await this.transport.request({ type: 'source-refresh' });
      if (version !== this.version) return;
      this.load(unit, this.settings);
      if (autoplay) await this.play();
    } catch (error) {
      if (version === this.version && error.name !== 'AbortError') throw error;
    }
  }
  invalidate(reason = new Error('The page changed. Close the player and reopen it at your reading position.')) { this.stop(); this.unavailable = reason; }
  stop() {
    const version = ++this.version; this.wantsPlay = false; this.abortFuture(); this.engine.stop();
    this.settling = this.unit?.source?.prefetch ? this.cancelSource(version) : Promise.resolve();
    this.settling.catch(this.onError); this.emit(); return this.settling;
  }
  observe(state) {
    if (state.state === 'playing') { this.wantsPlay = true; this.prefetch(); }
    if (['paused', 'idle', 'error', 'ended'].includes(state.state)) this.wantsPlay = false;
  }
  prefetch(force = false) {
    if (!this.unit?.source?.prefetch || this.pending || this.future.size >= 2 || this.endAfter || (!this.wantsPlay && !force)) return;
    const ocr = this.settings.provider === 'local' && this.unit.source?.format === 'ocr';
    const version = this.version, after = ocr ? [...this.future.values()].at(-1)?.unit.id || this.unit.id : this.unit.id;
    const count = ocr ? 1 : 2;
    const discovered = this.discover(after, count, version).catch(error => {
      if (version === this.version && error.name !== 'AbortError') { this.invalidate(error); this.onError(error); }
      throw error;
    });
    this.discovered = discovered;
    const pending = discovered.then(async () => {
      if (version !== this.version) return;
      for (const record of this.future.values()) {
        if (fullyConsumed(record.unit, this.consumed)) { record.ready = true; continue; }
        if (this.settings.provider === 'local' && record.unit.source?.format === 'ocr' && needsContinuation(record.unit)
          && this.future.size >= 2 && record === [...this.future.values()].at(-1) && record.unit.id !== this.endAfter) break;
        try {
          await record.engine.prepareSource();
          for (let i = 0; i < record.engine.segments.length; i++) {
            await record.engine.ensure(i);
            if (version !== this.version) return;
            const bytes = this.engine.bytes + [...this.future.values()].reduce((sum, value) => sum + value.engine.bytes, 0);
            if (bytes > 128 * 1024 * 1024) throw new Error('The reading queue reached its audio limit. Stop and start a new reading here.');
          }
        } catch (error) {
          if (record.promoted && error.name === 'AbortError') continue;
          throw error;
        }
        record.ready = true; this.emit();
      }
    }).catch(error => {
      if (version === this.version && error.name !== 'AbortError') { this.pause(); this.onError(error); }
    }).finally(() => {
      if (this.pending === pending) {
        this.pending = null; this.emit();
        if (this.wantsPlay && version === this.version && this.future.size < 2) this.prefetch();
      }
    });
    this.pending = pending; this.emit();
  }
  async discover(after, count, version) {
    const key = `${version}:${after}:${count}`;
    let pending = this.discoveries.get(key);
    if (!pending) {
      pending = this.transport.request({ type: 'source-next', after, count });
      this.discoveries.set(key, pending);
      pending.finally(() => { if (this.discoveries.get(key) === pending) this.discoveries.delete(key); }).catch(() => {});
    }
    const units = await pending;
    if (version !== this.version) return;
    if (units.length < count) this.endAfter = units.at(-1)?.id || after;
    for (const unit of units) if (!this.future.has(unit.id)) {
      const record = { unit, ready: false, promoted: false };
      record.engine = new ReaderEngine({ audio: this.createAudio(), cache: this.engine.cache,
        prepare: (unit, settings, signal) => this.prepare(unit, settings, signal, record.promoted ? 0 : 1),
        generate: (text, settings, signal) => this.generate(text, settings, signal, record.promoted ? 0 : 1) });
      record.engine.load(this.normalized(unit), this.settings); this.future.set(unit.id, record);
    }
  }
  async advance() {
    if (!this.unit?.source?.pagination) return false;
    const version = this.version;
    this.prefetch(); await this.discovered;
    if (version !== this.version || !this.wantsPlay) return false;
    let record = this.future.values().next().value;
    while (record && fullyConsumed(record.unit, this.consumed)) {
      this.unit = record.unit; this.future.delete(record.unit.id);
      record = this.future.values().next().value;
    }
    if (!record) {
      if (this.unit.id !== this.endAfter) {
        await this.pending;
        this.prefetch(); await this.discovered;
        if (this.future.size) return this.advance();
      }
      return false;
    }
    record.promoted = true;
    await record.engine.ensure(0);
    if (version !== this.version || !this.wantsPlay) return false;
    const unit = this.displayed === record.unit.id ? record.unit
      : await this.transport.request({ type: 'source-present', id: record.unit.id });
    if (version !== this.version) return false;
    const autoplay = this.wantsPlay;
    this.settings.speed = this.engine.speed;
    this.unit = unit; this.future.delete(unit.id);
    this.displayed = unit.id;
    this.engine.load(record.engine.article, this.settings, record.engine.segments);
    record.engine.stop();
    this.emit();
    if (autoplay) { this.wantsPlay = true; await this.engine.play(); }
    else this.engine.pause();
    return true;
  }
  async seekWord(position) {
    await this.engine.prepareSource();
    const locations = this.engine.article.locations;
    if (!locations) return this.engine.seekWord(position);
    const block = locations.findIndex((location, index) => location.unit === this.displayed && location.block === position.block
      && position.start >= location.offset && position.end <= location.offset + this.engine.article.blocks[index].length);
    if (block < 0) throw new Error('This word is outside the current reading. Reopen the player here.');
    return this.engine.seekWord({ block, start: position.start - locations[block].offset, end: position.end - locations[block].offset });
  }
  highlight(value, deliver) {
    const location = value && this.engine.article?.locations?.[value.block];
    if (!location) { deliver(value); return; }
    const mapped = { ...value, block: location.block,
      start: value.start == null ? null : value.start + location.offset,
      end: value.end == null ? null : value.end + location.offset };
    if (location.unit === this.displayed) { deliver(mapped); return; }
    if (this.presenting) return;
    const version = this.version;
    this.engine.audio.pause(); deliver(null);
    const pending = this.transport.request({ type: 'source-present', id: location.unit }).then(async () => {
      if (version !== this.version) return;
      this.displayed = location.unit; this.presenting = null;
      // A seek or pause can happen while the page is moving. Re-read the
      // current measured word rather than publishing the old request's mark.
      this.engine.lastHighlight = null; this.engine.tick();
      if (!this.presenting && this.engine.wantsPlay) await this.engine.audio.play();
    }).catch(error => { if (version === this.version) { this.invalidate(error); this.onError(error); } })
      .finally(() => { if (this.presenting === pending) this.presenting = null; });
    this.presenting = pending;
  }
}
