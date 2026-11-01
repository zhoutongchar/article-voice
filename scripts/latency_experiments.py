"""Experimental scheduler retained for headless comparisons; never shipped in the app."""
from concurrent.futures import Future
import heapq
import itertools
import queue
import threading

class CheckpointExecutor:
    def __init__(self, capacity=32, alignment_checkpoints=True):
        self.waiting = []; self.capacity = capacity; self.condition = threading.Condition()
        self.alignment_checkpoints = alignment_checkpoints
        self.counter = itertools.count(); self.closed = False
        self.thread = threading.Thread(target=self._work, name='article-voice-gpu', daemon=True); self.thread.start()

    def submit(self, operation, *args, priority=0, stage=None):
        future = Future()
        with self.condition:
            if self.closed: raise RuntimeError('Pipeline executor is closed')
            if len(self.waiting) >= self.capacity: raise queue.Full()
            heapq.heappush(self.waiting, (priority, 0 if self.alignment_checkpoints and stage == 'align' else 1, next(self.counter), future, operation, args, stage))
            self.condition.notify()
        return future

    def _execute(self, job):
        _, _, _, future, operation, args, _ = job
        if not future.set_running_or_notify_cancel(): return
        try: future.set_result(operation(*args))
        except BaseException as error: future.set_exception(error)

    def _work(self):
        while True:
            with self.condition:
                while not self.waiting and not self.closed: self.condition.wait()
                if not self.waiting: return
                job = heapq.heappop(self.waiting)
            self._execute(job)

    def yield_alignment(self, priority=0):
        # Only the GPU-owning thread may pause its speech generator. Never nest
        # another speech job: the decoder's streaming state belongs to that job.
        if threading.current_thread() is not self.thread: raise RuntimeError('Only the GPU owner can yield')
        if not self.alignment_checkpoints: return
        with self.condition:
            if not self.waiting or self.waiting[0][0] > priority or self.waiting[0][-1] != 'align': return
            job = heapq.heappop(self.waiting)
        self._execute(job)

    def shutdown(self, wait=True, cancel_futures=False):
        with self.condition:
            self.closed = True
            if cancel_futures:
                for job in self.waiting: job[3].cancel()
                self.waiting.clear()
            self.condition.notify_all()
        if wait: self.thread.join()
