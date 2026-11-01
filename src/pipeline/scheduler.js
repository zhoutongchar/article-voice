import { PipelineError } from './contracts.js';

// The scheduler owns jobs, never content. Resources have bounded queues and
// capacities; GPU execution is independently serialized by the native service.
export class StageScheduler {
  constructor(capacities = { rpc: 3 }, limit = 64) { this.capacities = capacities; this.limit = limit; this.waiting = []; this.running = new Map(); this.history = []; this.next = 0; }
  run(stage, inputId, operation, { signal, priority = 0, resource = 'rpc', onStage = () => {} } = {}) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(new DOMException('Cancelled', 'AbortError')); return; }
      if (this.waiting.length >= this.limit) { reject(new PipelineError('QUEUE_FULL', 'The reading queue is full.', stage, true)); return; }
      const job = { id: ++this.next, stage, inputId, resource, priority, state: 'queued', operation, signal, resolve, reject, onStage };
      job.abort = () => {
        const index = this.waiting.indexOf(job);
        if (index >= 0) { this.waiting.splice(index, 1); this.finish(job, 'cancelled', new DOMException('Cancelled', 'AbortError')); }
      };
      signal?.addEventListener('abort', job.abort, { once: true });
      this.waiting.push(job); this.waiting.sort((a, b) => a.priority - b.priority || a.id - b.id);
      this.event(job); this.drain();
    });
  }
  event(job) {
    const entry = { id: job.id, stage: job.stage, inputId: job.inputId, resource: job.resource, state: job.state, time: performance.now() };
    this.history.push(entry); if (this.history.length > this.limit * 4) this.history.shift();
    job.onStage(entry);
  }
  finish(job, state, error, value) {
    job.signal?.removeEventListener('abort', job.abort); job.state = state; this.event(job);
    error ? job.reject(error) : job.resolve(value);
  }
  drain() {
    for (let i = 0; i < this.waiting.length;) {
      const job = this.waiting[i], active = this.running.get(job.resource) || 0;
      if (active >= (this.capacities[job.resource] ?? 1)) { i++; continue; }
      this.waiting.splice(i, 1); this.running.set(job.resource, active + 1); job.state = 'running'; this.event(job);
      Promise.resolve().then(() => job.operation()).then(value => {
        if (job.signal?.aborted) this.finish(job, 'cancelled', new DOMException('Cancelled', 'AbortError'));
        else this.finish(job, 'completed', null, value);
      }, error => this.finish(job, error.name === 'AbortError' ? 'cancelled' : 'failed', error)).finally(() => {
        this.running.set(job.resource, (this.running.get(job.resource) || 1) - 1); this.drain();
      });
    }
  }
  snapshot() { return { running: Object.fromEntries(this.running), queued: this.waiting.map(({ id, stage, inputId, priority }) => ({ id, stage, inputId, priority })), history: [...this.history] }; }
}
