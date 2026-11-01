"""Bounded stage caches. Audio bytes are content-addressed, never source-addressed."""
import json
import os
import re
import threading
import time
import uuid
from pathlib import Path
from contracts import PipelineError, audio

class ArtifactStore:
    def __init__(self, directory, max_bytes=128 * 1024 * 1024, max_records=256):
        self.directory = Path(directory); self.max_bytes = max_bytes; self.max_records = max_records
        self.lock = threading.RLock()

    def path(self, stage, key, suffix='.json'):
        if stage not in ('audio', 'speech', 'alignment') or not re.fullmatch('[0-9a-f]{64}', key): raise ValueError('Invalid artifact key')
        return self.directory / stage / (key + suffix)

    def read(self, stage, key):
        with self.lock:
            path = self.path(stage, key)
            try:
                result = json.loads(path.read_text()); path.touch(); return result
            except (OSError, ValueError): return None

    def write(self, stage, key, value):
        with self.lock:
            path = self.path(stage, key); path.parent.mkdir(parents=True, exist_ok=True)
            temporary = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
            try: temporary.write_text(json.dumps(value, ensure_ascii=False, separators=(',', ':'))); temporary.replace(path)
            finally: temporary.unlink(missing_ok=True)
            files = sorted(path.parent.glob('*.json'), key=lambda p: p.stat().st_mtime)
            for old in files[:-self.max_records]: old.unlink(missing_ok=True)

    def put_audio(self, key, value, pcm):
        audio(value, pcm)
        with self.lock:
            path = self.path('audio', value['id'], '.pcm'); path.parent.mkdir(parents=True, exist_ok=True)
            temporary = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
            try: temporary.write_bytes(pcm); temporary.replace(path)
            finally: temporary.unlink(missing_ok=True)
            self.write('audio', value['id'], value); self.write('speech', key, {'audioId': value['id']})
            files = sorted(path.parent.glob('*.pcm'), key=lambda p: p.stat().st_mtime)
            total = sum(p.stat().st_size for p in files)
            for old in files:
                if total <= self.max_bytes and len(files) <= self.max_records: break
                total -= old.stat().st_size; old.unlink(missing_ok=True)
                self.path('audio', old.stem).unlink(missing_ok=True); files = files[1:]

    def get_audio(self, artifact_id):
        with self.lock:
            value = self.read('audio', artifact_id)
            try:
                pcm = self.path('audio', artifact_id, '.pcm').read_bytes(); audio(value, pcm)
                self.path('audio', artifact_id, '.pcm').touch()
                return value, pcm
            except (OSError, ValueError):
                raise PipelineError('ARTIFACT_EXPIRED', 'Prepared audio expired. Generate this passage again.', 'alignment', True) from None

    def speech(self, key):
        record = self.read('speech', key)
        if not record: return None
        try: return self.get_audio(record['audioId'])
        except (PipelineError, KeyError): return None
