"""One GPU owner, foreground priority, cancellation before execution."""
from concurrent.futures import Future
import itertools
import queue
import threading

class StageExecutor:
    def __init__(self, capacity=32):
        self.waiting = queue.PriorityQueue(capacity); self.counter = itertools.count(); self.closed = False
        self.thread = threading.Thread(target=self._work, name='article-voice-gpu', daemon=True); self.thread.start()

    def submit(self, operation, *args, priority=0):
        future = Future()
        if self.closed: raise RuntimeError('Pipeline executor is closed')
        self.waiting.put_nowait((priority, next(self.counter), future, operation, args))
        return future

    def _work(self):
        while True:
            _, _, future, operation, args = self.waiting.get()
            if operation is None: return
            if not future.set_running_or_notify_cancel(): continue
            try: future.set_result(operation(*args))
            except BaseException as error: future.set_exception(error)

    def shutdown(self, wait=True, cancel_futures=False):
        self.closed = True
        if cancel_futures:
            while True:
                try: self.waiting.get_nowait()[2].cancel()
                except queue.Empty: break
        self.waiting.put((float('inf'), next(self.counter), Future(), None, ()))
        if wait: self.thread.join()
