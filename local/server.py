"""Loopback-only companion for Article Voice. Run using npm run local."""
import argparse
import json
import queue
import select
import signal
import socket
import threading
import time
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, TimeoutError
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit
from runtime import CONFIG, SpeechRuntime
from streaming import PROTOCOL, RemoteRuntime, aligned_events

HOST = f"127.0.0.1:{CONFIG['port']}"
INSTANCE = None
runtime = SpeechRuntime()
worker = ThreadPoolExecutor(max_workers=1, thread_name_prefix="qwen")
slots = threading.BoundedSemaphore(4)
activity_lock = threading.Lock()
active_requests = 0
last_activity = time.monotonic()


def allowed_origin(origin):
    if origin in ("http://127.0.0.1:4317", f"http://{HOST}"):
        return True
    return bool(origin and origin.startswith("chrome-extension://") and len(origin.removeprefix("chrome-extension://")) == 32)


class Handler(BaseHTTPRequestHandler):
    def handle(self):
        global active_requests, last_activity
        with activity_lock:
            active_requests += 1
        try:
            super().handle()
        finally:
            with activity_lock:
                active_requests -= 1
                last_activity = time.monotonic()

    def log_message(self, *_):
        pass  # Never log article text, request bodies or credentials.

    def reply(self, status, value):
        body = json.dumps(value, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        origin = self.headers.get("Origin")
        if allowed_origin(origin):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def permitted(self):
        expected_host = f"{self.server.server_address[0]}:{self.server.server_address[1]}"
        if self.headers.get("Host") != expected_host or (self.headers.get("Origin") and not allowed_origin(self.headers["Origin"])):
            self.reply(403, {"error": "Use Article Voice or the local test page."})
            return False
        return True

    def do_OPTIONS(self):
        if not self.permitted():
            return
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", self.headers.get("Origin", ""))
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.end_headers()

    def do_GET(self):
        if not self.permitted():
            return
        path = urlsplit(self.path).path
        if path == "/health":
            self.reply(200, {"ready": runtime.ready, "streaming": PROTOCOL,
                             "instance": INSTANCE,
                             **{key: CONFIG[key] for key in ("model", "revision", "pipeline")}})
        elif path == "/voices":
            self.reply(200, {"voices": runtime.catalog(), "cursor": None,
                             **{key: CONFIG[key] for key in ("model", "revision", "pipeline")}})
        elif path == "/sample":
            sample = Path(__file__).resolve().parents[1] / "ChromeExtension/sample.html"
            if not sample.is_file():
                self.reply(404, {"error": "Reopen Article Voice to try its sample."})
                return
            body = sample.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.reply(404, {"error": "Unknown endpoint"})

    def do_POST(self):
        if not self.permitted():
            return
        if self.path not in ("/speech", "/speech/stream"):
            self.reply(404, {"error": "Unknown endpoint"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 32000 or self.headers.get_content_type() != "application/json":
                raise ValueError("Expected a short JSON passage")
            request = json.loads(self.rfile.read(length))
            text, voice, language = request.get("text"), request.get("voice"), request.get("language", "")
            prepare = request.get("prepare", True)
            if type(prepare) is not bool:
                raise ValueError("Invalid preparation mode")
            if not isinstance(text, str) or not text.strip() or len(text) > 2500:
                raise ValueError("Choose a passage of 1–2500 characters")
            if voice not in {v["id"] for v in CONFIG["voices"]}:
                raise ValueError("Choose an available local voice")
            if not isinstance(language, str) or (language and language not in CONFIG["languages"]):
                raise ValueError("This language is not supported by local Qwen")
        except (ValueError, TypeError, AttributeError):
            self.reply(400, {"error": "Invalid passage, voice or language"})
            return
        reference = runtime.reference_identity(voice)
        if reference is None or request.get("referenceId") != reference:
            self.reply(409, {"error": "Reconnect the local voice to use its current reference recording"})
            return
        if not slots.acquire(blocking=False):
            self.reply(429, {"error": "Local reader is busy. Try again shortly."})
            return
        cancelled = threading.Event()
        if self.path == "/speech/stream":
            self.stream(text, voice, language, cancelled, prepare)
            return
        future = worker.submit(runtime.generate, text, voice, language, cancelled, **({} if prepare else {"prepare": False}))
        future.add_done_callback(lambda _: slots.release())
        try:
            while True:
                try:
                    result = future.result(timeout=.2)
                    self.reply(200, result)
                    return
                except TimeoutError:
                    readable, _, _ = select.select([self.connection], [], [], 0)
                    if readable and not self.connection.recv(1, socket.MSG_PEEK):
                        cancelled.set()
                        future.cancel()
                        return
        except Exception as error:
            # Full traces belong in the local terminal; no article is printed.
            print(f"Local speech failed: {type(error).__name__}: {error}", flush=True)
            self.reply(500, {"error": "Local speech failed. Check the companion terminal."})

    def disconnected(self):
        readable, _, _ = select.select([self.connection], [], [], 0)
        return bool(readable and not self.connection.recv(1, socket.MSG_PEEK))

    def stream(self, text, voice, language, cancelled, prepare=True):
        events = queue.Queue(maxsize=2)

        def emit(event):
            while not cancelled.is_set():
                try:
                    events.put(event, timeout=.2)
                    return
                except queue.Full:
                    pass

        def produce():
            try:
                for event in aligned_events(runtime, text, voice, language, cancelled, prepare):
                    if cancelled.is_set():
                        return
                    emit(event)
            except Exception as error:
                print(f"Stream stopped: {type(error).__name__}", flush=True)
                emit({"type": "error", "error": "This reading stopped before all its audio was ready. Try again."})

        future = worker.submit(produce)
        future.add_done_callback(lambda _: slots.release())
        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        origin = self.headers.get("Origin")
        if allowed_origin(origin):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.end_headers()
        try:
            self.wfile.write((json.dumps({"type": "start", "protocol": PROTOCOL}) + "\n").encode())
            self.wfile.flush()
            while not cancelled.is_set():
                try:
                    event = events.get(timeout=.2)
                except queue.Empty:
                    if self.disconnected():
                        return
                    continue
                self.wfile.write((json.dumps(event, ensure_ascii=False) + "\n").encode())
                self.wfile.flush()
                if event["type"] in ("done", "error"):
                    return
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            cancelled.set()
            future.cancel()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=CONFIG["port"])
    parser.add_argument("--data-dir")
    parser.add_argument("--instance-token")
    parser.add_argument("--upstream-port", type=int)
    parser.add_argument("--models-dir")
    parser.add_argument("--idle-timeout", type=float, default=0)
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("port must be between 1 and 65535")
    if args.upstream_port is not None and (not 1 <= args.upstream_port <= 65535 or args.upstream_port == args.port):
        parser.error("upstream port must be a different loopback port between 1 and 65535")
    HOST = f"127.0.0.1:{args.port}"
    INSTANCE = args.instance_token
    runtime = RemoteRuntime(args.upstream_port) if args.upstream_port else SpeechRuntime(args.data_dir, args.models_dir)
    print("Loading Qwen speech and word alignment on your Mac…", flush=True)
    worker.submit(runtime.load).result()
    print(f"Local Article Voice ready · http://{HOST} · no cloud inference", flush=True)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    if args.idle_timeout > 0:
        def retire_when_idle():
            while True:
                time.sleep(min(5, args.idle_timeout))
                with activity_lock:
                    idle = not active_requests and time.monotonic() - last_activity >= args.idle_timeout
                if idle:
                    server.shutdown()
                    return
        threading.Thread(target=retire_when_idle, daemon=True).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        signal.signal(signal.SIGINT, signal.SIG_IGN)
    finally:
        server.server_close()
        worker.shutdown(wait=True, cancel_futures=True)
