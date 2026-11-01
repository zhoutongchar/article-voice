import { paragraphPassages } from '../article.js';

// Coordinates, images and navigation stay in the page. Only serializable
// reading units cross the bridge to the common player and speech queue.
export class SourceHost {
  constructor(adapter) { this.adapter = adapter; }
  serialize(unit) {
    return { id: unit.id, title: unit.title, url: unit.url, language: unit.language || '', label: unit.label || '',
      source: { id: this.adapter.id, ...this.adapter.capabilities },
      blocks: unit.blocks.map(block => block.text), passages: paragraphPassages(unit.blocks) };
  }
  async open() { return this.serialize(await this.adapter.open()); }
  async prepareNext(after, count = 2) {
    if (count !== 1 && count !== 2) throw new Error('Choose one or two following pages.');
    if (!this.adapter.capabilities.prefetch) return [];
    if (!this.adapter.has(after)) throw new Error('This reading position is no longer available.');
    return (await this.adapter.prepareNext(after, count)).map(unit => this.serialize(unit));
  }
  async present(id) {
    if (!this.adapter.has(id)) throw new Error('This queued reading is no longer available.');
    return this.serialize(await this.adapter.present(id));
  }
  span(block, start, end) { return this.adapter.span(block, start, end); }
  wordAtPoint(x, y) { return this.adapter.wordAtPoint(x, y); }
  async cancel() {
    await this.adapter.cancel();
    const unit = this.adapter.current();
    return unit ? this.serialize(unit) : null;
  }
  async dispose() { await this.adapter.dispose(); }
}
