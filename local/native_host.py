"""Chrome Native Messaging, one cancellable request per port; no stdout logging."""
import json
import struct
import sys
import time
import signal
import subprocess
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request
from companion import CONNECTION, DIRECTORY, HTTP, ensure_engine, health, write_json

MAX_MESSAGE = 1024 * 1024
MAX_OCR_REQUEST = 12 * 1024 * 1024


def exact(stream, count):
    value = bytearray()
    while len(value) < count:
        chunk = stream.read(count - len(value))
        if not chunk:
            raise EOFError()
        value.extend(chunk)
    return bytes(value)


def receive(stream):
    length = struct.unpack("=I", exact(stream, 4))[0]
    if not 0 < length <= MAX_OCR_REQUEST:
        raise ValueError("Choose a shorter reading.")
    value = json.loads(exact(stream, length))
    if not isinstance(value, dict):
        raise ValueError("Invalid reader request")
    text_request = value.get('method') in ('prepare', 'speech')
    if value.get('method') != 'ocr' and length > (96000 if text_request else 32000):
        raise ValueError("Choose a shorter reading.")
    return value


def recognize(payload):
    if not isinstance(payload, dict) or not isinstance(payload.get('image'), str) or len(payload['image']) > 11_184_812:
        raise ValueError('This page image is too large. Try a smaller reader window.')
    executable = Path(__file__).resolve().parents[2] / 'MacOS' / 'ArticleVoiceOCR'
    if not executable.is_file():
        executable = Path(__file__).resolve().parents[1] / 'macos' / '.build' / 'release' / 'ArticleVoiceOCR'
    if not executable.is_file():
        raise ValueError('Update Article Voice on this Mac to enable image reading.')
    body = json.dumps({'image': payload['image'], 'language': payload.get('language', '')}).encode()
    previous = signal.getsignal(signal.SIGTERM)
    def terminate(*_): raise SystemExit(143)
    with subprocess.Popen([str(executable)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE) as child:
        signal.signal(signal.SIGTERM, terminate)
        try:
            output, _ = child.communicate(body, timeout=30)
            if len(output) > MAX_MESSAGE:
                raise ValueError('This page contains too much text. Increase the book font size.')
            value = json.loads(output)
            if child.returncode or value.get('error'):
                raise ValueError(value.get('error') or 'This page could not be recognized.')
            return value
        finally:
            if child.poll() is None:
                child.terminate()
                try: child.wait(timeout=2)
                except subprocess.TimeoutExpired: child.kill(); child.wait()
            signal.signal(signal.SIGTERM, previous)


def send(value, stream=None):
    stream = stream or sys.stdout.buffer
    body = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()
    if len(body) > MAX_MESSAGE:
        raise ValueError("The voice response was too large.")
    stream.write(struct.pack("=I", len(body)) + body)
    stream.flush()


def run(origin, source=None, emit=send):
    if origin != f"chrome-extension://{CONNECTION['extensionId']}/":
        raise ValueError("Connect the official Article Voice extension.")
    request = receive(source or sys.stdin.buffer)
    method = request.get("method")
    if method not in ("heartbeat", "status", "voices", "speech", "ocr", "prepare"):
        raise ValueError("Unknown reader request")
    if method == "heartbeat":
        write_json(DIRECTORY / "chrome-connection.json", {"protocolVersion": 1,
                   "extensionId": CONNECTION["extensionId"], "connectedAt": time.time()})
        emit({"type": "result", "value": {"connected": True}})
        return
    if method == "status":
        emit({"type": "result", "value": {"connected": True, "ready": bool((health(CONNECTION['port']) or {}).get('ready'))}})
        return
    if method == 'ocr':
        emit({'type': 'result', 'value': recognize(request.get('payload'))})
        return
    port = ensure_engine(lambda **value: emit({"type": "progress", **value}))
    if method == "voices":
        with HTTP.open(f"http://127.0.0.1:{port}/voices", timeout=10) as response:
            emit({"type": "result", "value": json.load(response)})
        return
    if method == 'prepare':
        payload = request.get('payload')
        if not isinstance(payload, dict): raise ValueError('Invalid page text')
        body = json.dumps({'text': payload.get('text')}, ensure_ascii=False).encode()
        if len(body) > 96000: raise ValueError('This page contains too much text. Increase the book font size.')
        query = Request(f'http://127.0.0.1:{port}/prepare', data=body, headers={'Content-Type': 'application/json'})
        with HTTP.open(query, timeout=180) as response:
            emit({'type': 'result', 'value': json.load(response)})
        return
    payload = request.get("payload")
    if not isinstance(payload, dict):
        raise ValueError("Invalid speech request")
    body = json.dumps({**{key: payload.get(key) for key in ("text", "voice", "language", "referenceId")},
                       **({'preparation': payload['preparation']} if 'preparation' in payload else {})}, ensure_ascii=False).encode()
    if len(body) > 96000:
        raise ValueError("Choose a shorter passage.")
    query = Request(f"http://127.0.0.1:{port}/speech", data=body, headers={"Content-Type": "application/json"})
    try:
        with HTTP.open(query, timeout=180) as response:
            value = json.load(response)
    except HTTPError as error:
        if error.code == 400:
            try: message = json.loads(error.read(4096)).get('error')
            except (ValueError, AttributeError): message = None
            if isinstance(message, str) and message: raise ValueError(message) from None
        raise ValueError("Your voice changed. Reconnect in the reader’s Settings." if error.code == 409 else
                         "The voice engine is busy. Try this passage again.") from None
    pcm = value.pop("pcm")
    emit({"type": "audio", "value": value})
    # Chrome limits host-to-extension messages to 1 MB; split the PCM before framing.
    for offset in range(0, len(pcm), 192000):
        emit({"type": "chunk", "data": pcm[offset:offset + 192000]})
    emit({"type": "done"})


if __name__ == "__main__":
    try:
        run(sys.argv[1] if len(sys.argv) > 1 else "")
    except (EOFError, BrokenPipeError):
        pass
    except Exception as error:
        try:
            send({"type": "error", "error": str(error) if isinstance(error, ValueError) else "Open Article Voice to finish setting up your voices."})
        except BrokenPipeError:
            pass
