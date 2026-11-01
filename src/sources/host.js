import { randomId } from '../hash.js';
import { contentChunksFromUnit } from '../pipeline/contracts.js';
import { paragraphPassages } from '../text-segmentation.js';

// Coordinates, images and navigation stay in the page. Only serializable
// reading units cross the bridge to the common player and speech queue.
export class SourceHost {
  constructor(adapter) { this.adapter = adapter; this.contents = new Map(); this.streamId = randomId(); this.sequence = 0; }
  async serialize(unit) {
    for (const id of this.contents.keys()) if (!this.adapter.has(id)) this.contents.delete(id);
    if (!this.contents.has(unit.id)) {
      const chunks = await contentChunksFromUnit({ ...unit, streamId: this.streamId, sequence: this.sequence, stability: this.adapter.capabilities.format === 'ocr' ? 'draft' : 'sealed', source: this.adapter.capabilities, blocks: unit.blocks.map(b => b.text) });
      this.sequence += chunks.length; this.contents.set(unit.id, chunks);
    }
    return { id: unit.id, title: unit.title, url: unit.url, language: unit.language || '', label: unit.label || '',
      source: { id: this.adapter.id, ...this.adapter.capabilities }, contentChunks: this.contents.get(unit.id),
      blocks: unit.blocks.map(block => block.text), passages: paragraphPassages(unit.blocks) };
  }
  async open() { return this.serialize(await this.adapter.open()); }
  async prepareNext(after, count = 2) {
    if (count !== 1 && count !== 2) throw new Error('Choose one or two following pages.');
    if (!this.adapter.capabilities.prefetch) return [];
    if (!this.adapter.has(after)) throw new Error('This reading position is no longer available.');
    const units = await this.adapter.prepareNext(after, count), result = [];
    // Assign stream sequence numbers in reading order before downstream jobs run.
    for (const unit of units) result.push(await this.serialize(unit));
    return result;
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
  async dispose() { this.contents.clear(); await this.adapter.dispose(); }
}
