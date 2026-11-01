import { ocrBlocks, imageSpan, imageWordAtPoint } from './ocr.js';

const aborted = () => new DOMException('Cancelled', 'AbortError');

// A paged image source owns traversal and its temporary presentation. Future
// adapters can supply a non-mutating page cache through a different access
// implementation without changing the player or the audio queue.
export function createPagedImageSource({ id, access, recognize }) {
  const units = [];
  let actual = 0, current = 0, active, tail = Promise.resolve(), disposed = false, generation = 0, invalid = false;
  const work = operation => {
    const version = generation;
    const pending = tail.catch(() => {}).then(async () => {
      if (disposed || version !== generation) throw aborted();
      if (invalid) throw new Error('The book position changed. Close the reader and reopen it.');
      const controller = active = new AbortController();
      try { return await operation(controller.signal); }
      finally { if (active === controller) active = null; }
    });
    tail = pending; return pending;
  };
  async function snapshot(image, signal) {
    const found = units.find(unit => unit.id === image.id);
    if (found?.blocks) return found;
    const value = await recognize(image.image, signal);
    if (signal.aborted) throw aborted();
    return { ...image, blocks: ocrBlocks(value) };
  }
  async function move(index, signal) {
    while (actual !== index) {
      if (signal?.aborted) throw aborted();
      const direction = index > actual ? 1 : -1;
      const image = await access.turn(direction, signal);
      if (!image || image.id !== units[actual + direction]?.id)
        throw new Error(`The reader returned a different page while going ${direction > 0 ? 'forward' : 'back'}.`);
      actual += direction;
    }
  }
  async function restore() {
    // Restoration is finalization, even after Stop. A changed position is an
    // explicit failure, and the user keeps access to Kindle's own controls.
    try {
      await move(current);
      if (units[current] && (await access.capture()).id !== units[current].id) throw new Error('The displayed page does not match the page being read.');
    } catch (cause) {
      invalid = true;
      throw new Error(`Could not return to ${units[current]?.label || 'your reading position'}. ${cause.message} Reading stopped. Close the player and use the book’s navigation.`, { cause });
    } finally { access.uncover(); }
  }
  const source = {
    id, capabilities: { format: 'ocr', pagination: true, prefetch: true, scroll: false },
    has: key => units.some(unit => unit.id === key),
    current: () => units[current] || null,
    invalidate() { invalid = true; generation++; active?.abort(); },
    open: () => work(async signal => {
      let image = await access.capture(signal);
      while (true) {
        const unit = await snapshot(image, signal), visible = await access.capture(signal);
        if (visible.id === image.id) {
          units.splice(0, units.length, unit); actual = current = 0; return unit;
        }
        image = visible;
      }
    }),
    prepareNext: (after, count = 2) => work(async signal => {
      const start = units.findIndex(unit => unit.id === after);
      if (start < 0) throw new Error('This page is no longer in the reading queue.');
      access.cover(units[current]);
      try {
        await move(start, signal);
        for (let i = 0; i < Math.min(2, count); i++) {
          if (signal.aborted) throw aborted();
          if (units[actual + 1]) {
            await move(actual + 1, signal);
            if (!units[actual].blocks) units[actual] = await snapshot(await access.capture(signal), signal);
            continue;
          }
          const image = await access.turn(1, signal);
          if (!image) { units[actual].last = true; break; }
          if (units.some(unit => unit.id === image.id)) throw new Error('The reader did not advance to a new page.');
          // Record the traversal before OCR: even failed/cancelled recognition
          // must be able to navigate back from the page we actually reached.
          units.push({ ...image, blocks: null }); actual++;
          units[actual] = await snapshot(image, signal);
        }
        const next = units.slice(start + 1, start + 1 + Math.min(2, count));
        return next.filter(unit => unit.blocks);
      } finally { await restore(); }
    }),
    present: key => work(async signal => {
      const target = units.findIndex(unit => unit.id === key);
      if (target < 0 || !units[target].blocks) throw new Error('This page is no longer in the reading queue.');
      access.cover(units[current]);
      try {
        await move(target, signal); current = target;
        // Keep one previous unit and two future units, including their images.
        const remove = Math.max(0, current - 1);
        units.splice(0, remove); actual -= remove; current -= remove;
        return units[current];
      } finally { await restore(); }
    }),
    span: (block, start, end) => !invalid && units[current]?.blocks ? imageSpan(units[current], access.rectangle(), block, start, end) : null,
    wordAtPoint: (x, y) => !invalid && units[current]?.blocks ? imageWordAtPoint(units[current], access.rectangle(), x, y) : null,
    async cancel() { generation++; active?.abort(); await tail.catch(() => {}); },
    async dispose() {
      await source.cancel();
      try { if (!invalid) await restore(); }
      finally { disposed = true; access.dispose(); units.length = 0; }
    }
  };
  return source;
}
