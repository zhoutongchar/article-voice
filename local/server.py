"""Loopback-only companion for Article Voice. Run using npm run local."""
import json
import select
import signal
import socket
import threading
from concurrent.futures import ThreadPoolExecutor, TimeoutError
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit
from runtime import CONFIG, SpeechRuntime

HOST = f"127.0.0.1:{CONFIG['port']}"
runtime = SpeechRuntime()
worker = ThreadPoolExecutor(max_workers=1, thread_name_prefix="qwen")
slots = threading.BoundedSemaphore(4)


def allowed_origin(origin):
    if origin in ("http://127.0.0.1:4317", f"http://{HOST}"):
        return True
    return bool(origin and origin.startswith("chrome-extension://") and len(origin.removeprefix("chrome-extension://")) == 32)


class Handler(BaseHTTPRequestHandler):
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
            self.reply(200, {"ready": runtime.tts is not None and runtime.aligner is not None,
                             **{key: CONFIG[key] for key in ("model", "revision", "pipeline")}})
        elif path == "/voices":
            self.reply(200, {"voices": runtime.references.catalog(), "cursor": None,
                             **{key: CONFIG[key] for key in ("model", "revision", "pipeline")}})
        else:
            self.reply(404, {"error": "Unknown endpoint"})

    def do_POST(self):
        if not self.permitted():
            return
        if self.path != "/speech":
            self.reply(404, {"error": "Unknown endpoint"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 32000 or self.headers.get_content_type() != "application/json":
                raise ValueError("Expected a short JSON passage")
            request = json.loads(self.rfile.read(length))
            text, voice, language = request.get("text"), request.get("voice"), request.get("language", "")
            if not isinstance(text, str) or not text.strip() or len(text) > 2500:
                raise ValueError("Choose a passage of 1–2500 characters")
            if voice not in {v["id"] for v in CONFIG["voices"]}:
                raise ValueError("Choose an available local voice")
            if not isinstance(language, str) or (language and language not in CONFIG["languages"]):
                raise ValueError("This language is not supported by local Qwen")
        except (ValueError, TypeError, AttributeError):
            self.reply(400, {"error": "Invalid passage, voice or language"})
            return
        reference = runtime.references.voices.get(voice)
        if reference is None or request.get("referenceId") != reference.identity:
            self.reply(409, {"error": "Reconnect the local voice to use its current reference recording"})
            return
        if not slots.acquire(blocking=False):
            self.reply(429, {"error": "Local reader is busy. Try again shortly."})
            return
        cancelled = threading.Event()
        future = worker.submit(runtime.generate, text, voice, language, cancelled)
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


if __name__ == "__main__":
    print("Loading Qwen speech and word alignment on your Mac…", flush=True)
    worker.submit(runtime.load).result()
    print(f"Local Article Voice ready · http://{HOST} · no cloud inference", flush=True)
    server = ThreadingHTTPServer(("127.0.0.1", CONFIG["port"]), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        signal.signal(signal.SIGINT, signal.SIG_IGN)
    finally:
        server.server_close()
        worker.shutdown(wait=True, cancel_futures=True)
