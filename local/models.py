"""Pinned, resumable model installation. No package manager or user setup."""
import hashlib
import json
import os
import shutil
import time
from pathlib import Path, PurePosixPath
from urllib.error import HTTPError
from urllib.request import Request, urlopen


def digest(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def valid(path, file):
    return path.is_file() and path.stat().st_size == file["size"] and digest(path) == file["sha256"]


def download(url, target, file, progress, opener=urlopen):
    """Only a verified final file is usable; interrupted .part files resume."""
    target.parent.mkdir(parents=True, exist_ok=True)
    partial = target.with_name(target.name + ".part")
    if partial.exists() and partial.stat().st_size > file["size"]:
        partial.unlink()
    offset = partial.stat().st_size if partial.exists() else 0
    if offset < file["size"]:
        request = Request(url, headers={"Range": f"bytes={offset}-"} if offset else {})
        with opener(request, timeout=30) as response:
            if offset and response.status == 206:
                if not response.headers.get("Content-Range", "").startswith(f"bytes {offset}-"):
                    raise ValueError("The model download returned an invalid resume position. Try again.")
            else:
                offset = 0
            with partial.open("ab" if offset else "wb") as output:
                progress(offset)
                while chunk := response.read(1024 * 1024):
                    if offset + len(chunk) > file["size"]:
                        raise ValueError("The model download was larger than expected.")
                    output.write(chunk); offset += len(chunk); progress(offset)
    if not valid(partial, file):
        partial.unlink(missing_ok=True)
        raise ValueError("The voice download could not be verified. Retry to download it again.")
    partial.replace(target)


def install(manifest, directory, report, cache=None, base_url="https://huggingface.co"):
    directory = Path(directory)
    cache = Path(cache) if cache else Path(os.environ.get("HF_HUB_CACHE", Path(os.environ.get("HF_HOME", Path.home() / ".cache/huggingface")) / "hub"))
    total = sum(file["size"] for model in manifest["models"] for file in model["files"])
    completed = 0
    directory.mkdir(parents=True, exist_ok=True)
    # Allow a useful retry without consuming disk until it becomes completely full.
    required = sum(f["size"] for m in manifest["models"] for f in m["files"]
                   if not (directory / m["name"] / f["path"]).is_file())
    if shutil.disk_usage(directory).free < required + 256 * 1024 * 1024:
        raise ValueError("Free about 4 GB on this Mac, then try the voice download again.")
    for model in manifest["models"]:
        for file in model["files"]:
            relative = PurePosixPath(file["path"])
            if relative.is_absolute() or ".." in relative.parts:
                raise ValueError("Invalid packaged model manifest")
            target = directory / model["name"] / file["path"]
            report(stage="voices", message="Preparing your voices…", completed=completed, total=total)
            if not valid(target, file):
                cached = cache / ("models--" + model["repo"].replace("/", "--")) / "snapshots" / model["revision"] / file["path"]
                target.parent.mkdir(parents=True, exist_ok=True)
                if valid(cached, file):
                    temporary = target.with_name(target.name + ".import")
                    temporary.unlink(missing_ok=True)
                    try:
                        os.link(cached.resolve(), temporary)
                    except OSError:
                        shutil.copyfile(cached, temporary)
                    temporary.replace(target)
                else:
                    for attempt in range(3):
                        try:
                            download(f"{base_url}/{model['repo']}/resolve/{model['revision']}/{file['path']}", target, file,
                                     lambda received: report(stage="voices", message="Downloading your voices…", completed=completed + received, total=total))
                            break
                        except (OSError, HTTPError):
                            if attempt == 2:
                                raise ValueError("The voice download paused. Check your connection and click Resume; completed downloads are kept.") from None
                            time.sleep(attempt + 1)
            completed += file["size"]
            report(stage="voices", message="Preparing your voices…", completed=completed, total=total)
    return total
