"""Aligned paragraphs, with exact source offsets and no guessed timings."""
import json
import re
from urllib.request import ProxyHandler, Request, build_opener
from runtime import CONFIG

PROTOCOL = "aligned-paragraphs-v1"


def pieces(text):
    cursor = 0
    for boundary in (*re.finditer(r"\r?\n[ \t]*\r?\n", text), None):
        end = boundary.start() if boundary else len(text)
        raw = text[cursor:end]
        value = raw.strip()
        if value:
            start = cursor + len(raw) - len(raw.lstrip())
            yield value, len(text[:start].encode("utf-16-le")) // 2
        cursor = boundary.end() if boundary else len(text)


def aligned_events(runtime, text, voice, language, cancelled, prepare=True):
    for value, offset in pieces(text):
        if cancelled.is_set():
            raise InterruptedError("Reading cancelled")
        clip = runtime.generate(value, voice, language, cancelled, **({} if prepare else {"prepare": False}))
        if cancelled.is_set():
            raise InterruptedError("Reading cancelled")
        yield {"type": "clip", "text": value, "offset": offset, "clip": clip}
    yield {"type": "done"}


class RemoteRuntime:
    """Reuse the running Qwen service; this helper loads no second model copy."""
    def __init__(self, port):
        self.base = f"http://127.0.0.1:{port}"
        self.ready = False
        self._voices = []
        self._http = build_opener(ProxyHandler({}))

    def _request(self, path, body=None):
        request = Request(self.base + path, data=None if body is None else json.dumps(body).encode(),
                          headers={} if body is None else {"Content-Type": "application/json"})
        with self._http.open(request, timeout=180) as response:
            return json.load(response)

    def load(self):
        health = self._request("/health")
        if not health.get("ready") or any(health.get(key) != CONFIG[key] for key in ("model", "revision", "pipeline")):
            raise ValueError("Existing Qwen service is not ready or compatible")
        catalog = self._request("/voices")
        if any(catalog.get(key) != CONFIG[key] for key in ("model", "revision", "pipeline")):
            raise ValueError("Existing Qwen catalog is incompatible")
        voices = catalog.get("voices")
        if not isinstance(voices, list) or {v.get("id") for v in voices} != {v["id"] for v in CONFIG["voices"]}:
            raise ValueError("Existing Qwen voices are incompatible")
        if any(not re.fullmatch(r"[0-9a-f]{64}", v.get("referenceId", "")) for v in voices):
            raise ValueError("Existing Qwen reference identities are invalid")
        self._voices = voices
        self.ready = True

    def catalog(self):
        return self._voices

    def reference_identity(self, voice):
        return next((item["referenceId"] for item in self._voices if item["id"] == voice), None)

    def prepare(self, text, cancelled=None):
        if cancelled and cancelled.is_set(): raise InterruptedError('Reading cancelled')
        return self._request('/prepare', {'text': text})

    def generate(self, text, voice, language, cancelled=None, prepare=True, preparation=None):
        if cancelled and cancelled.is_set():
            raise InterruptedError("Reading cancelled")
        result = self._request("/speech", {"text": text, "voice": voice, "language": language,
                                          "referenceId": self.reference_identity(voice), "prepare": prepare,
                                          **({'preparation': preparation} if preparation is not None else {})})
        if cancelled and cancelled.is_set():
            raise InterruptedError("Reading cancelled")
        return result
