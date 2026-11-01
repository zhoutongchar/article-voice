// One voice request at a time across the active reading and prepared units.
// Foreground work takes priority over work that has not started yet.
export class WorkQueue {
  waiting = [];
  running = false;
  run(operation, signal, priority = 0) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(new DOMException('Cancelled', 'AbortError')); return; }
      this.waiting.push({ operation, signal, priority, resolve, reject });
      this.waiting.sort((a, b) => a.priority - b.priority);
      this.drain();
    });
  }
  async drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.waiting.length) {
        const item = this.waiting.shift();
        if (item.signal?.aborted) { item.reject(new DOMException('Cancelled', 'AbortError')); continue; }
        try { item.resolve(await item.operation()); } catch (error) { item.reject(error); }
      }
    } finally { this.running = false; }
  }
}
