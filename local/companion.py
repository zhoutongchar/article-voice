"""One Chrome voice engine, started on demand and shared by app and extension."""
import fcntl
import json
import os
import shutil
import subprocess
import sys
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from urllib.request import ProxyHandler, build_opener
from runtime import CONFIG
from models import install

RESOURCES = Path(__file__).resolve().parents[1]
CONNECTION = json.loads((RESOURCES / "chrome/connection.json").read_text())
DIRECTORY = Path.home() / "Library/Application Support/Article Voice"
HTTP = build_opener(ProxyHandler({}))


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    temporary.write_text(json.dumps(value))
    temporary.replace(path)


def health(port):
    try:
        with HTTP.open(f"http://127.0.0.1:{port}/health", timeout=1) as response:
            value = json.load(response)
        if any(value.get(key) != CONFIG[key] for key in ("model", "revision", "pipeline")):
            raise ValueError("Another voice service is using Article Voice’s connection. Quit it and retry.")
        return value
    except OSError:
        return None


@contextmanager
def locked(directory, name, report):
    directory.mkdir(parents=True, exist_ok=True)
    with (directory / name).open("a") as handle:
        started = time.monotonic()
        while True:
            try:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() - started > 1800:
                    raise ValueError("Voice setup is already open. Return to Article Voice to finish it.")
                report(stage="waiting", message="Waiting for voice setup…")
                time.sleep(.5)
        try:
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


def ensure_engine(report=lambda **_: None, directory=DIRECTORY, resources=RESOURCES, port=None, verify_models=False):
    port = port or CONNECTION["port"]
    with locked(directory, "chrome-engine.lock", report):
        current = health(port)
        if current and current.get("ready") and not verify_models:
            return port
        references = directory / "voice-references"
        references.mkdir(exist_ok=True)
        for entry in (resources / "VoiceReferences").iterdir():
            target = references / entry.name
            if not target.exists():
                shutil.copytree(entry, target)
        manifest = json.loads((resources / "local/model-files.json").read_text())
        receipt = directory / "models-ready.json"
        manifest_id = __import__("hashlib").sha256((resources / "local/model-files.json").read_bytes()).hexdigest()
        installed = None
        try:
            installed = json.loads(receipt.read_text())
        except (OSError, ValueError):
            pass
        paths_present = all((directory / "Models" / m["name"] / f["path"]).is_file() and
                            (directory / "Models" / m["name"] / f["path"]).stat().st_size == f["size"]
                            for m in manifest["models"] for f in m["files"])
        if verify_models or installed != {"manifest": manifest_id} or not paths_present:
            install(manifest, directory / "Models", report)
            write_json(receipt, {"manifest": manifest_id})
        if current and current.get("ready"):
            return port
        report(stage="engine", message="Warming up your voices…")
        upstream = health(4318)
        token = uuid.uuid4().hex
        arguments = [sys.executable, "-s", "-u", str(resources / "local/server.py"), "--port", str(port),
                     "--data-dir", str(directory), "--models-dir", str(directory / "Models"),
                     "--instance-token", token, "--idle-timeout", "600"]
        if upstream and upstream.get("ready"):
            arguments += ["--upstream-port", "4318"]
        with (directory / "chrome-engine.log").open("ab") as log:
            child = subprocess.Popen(arguments, stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
        for _ in range(240):
            value = health(port)
            if value and value.get("ready"):
                if value.get("instance") != token:
                    raise ValueError("Another service started on this connection. Reopen Article Voice.")
                return port
            if child.poll() is not None:
                raise ValueError("The voice engine couldn’t start. Open Article Voice and click Retry.")
            time.sleep(.5)
        child.terminate()
        child.wait(timeout=10)
        raise ValueError("The voices are taking too long to start. Open Article Voice and retry.")
