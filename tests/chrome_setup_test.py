"""Real HTTP download/resume and native-protocol boundaries; no speech mocks claimed as GPU tests."""
import hashlib
import io
import json
from pathlib import Path
import socket
import struct
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'local'))
from models import download, install
import native_host

PAYLOAD = b'a verified model fixture' * 1000
FILE = {'path': 'weights.bin', 'size': len(PAYLOAD), 'sha256': hashlib.sha256(PAYLOAD).hexdigest()}


class DownloadHandler(BaseHTTPRequestHandler):
    ranges = []
    ignore_range = False
    def log_message(self, *_): pass
    def do_GET(self):
        request_range = self.headers.get('Range')
        self.ranges.append(request_range)
        offset = int(request_range.split('=')[1].split('-')[0]) if request_range and not self.ignore_range else 0
        self.send_response(206 if offset else 200)
        if offset: self.send_header('Content-Range', f'bytes {offset}-{len(PAYLOAD)-1}/{len(PAYLOAD)}')
        self.send_header('Content-Length', str(len(PAYLOAD)-offset)); self.end_headers()
        self.wfile.write(PAYLOAD[offset:])


class SetupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.root = Path(self.temp.name)
        DownloadHandler.ranges = []; DownloadHandler.ignore_range = False
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), DownloadHandler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True); self.thread.start()
        self.url = f'http://127.0.0.1:{self.server.server_port}/weights'
    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join(); self.temp.cleanup()
    def test_resumes_partial_download_and_verifies_before_publishing(self):
        target = self.root / 'model.bin'; target.with_suffix('.bin.part').write_bytes(PAYLOAD[:217])
        progress=[]; download(self.url, target, FILE, progress.append)
        self.assertEqual(DownloadHandler.ranges, ['bytes=217-'])
        self.assertEqual(target.read_bytes(), PAYLOAD); self.assertEqual(progress[-1], len(PAYLOAD))
        self.assertFalse(target.with_suffix('.bin.part').exists())
    def test_server_ignoring_range_restarts_instead_of_appending(self):
        target = self.root/'model.bin'; target.with_suffix('.bin.part').write_bytes(PAYLOAD[:200])
        DownloadHandler.ignore_range = True
        download(self.url, target, FILE, lambda _: None)
        self.assertEqual(target.read_bytes(), PAYLOAD)
    def test_corrupt_completed_file_is_not_installed(self):
        target = self.root/'model.bin'
        with self.assertRaisesRegex(ValueError, 'verified'):
            download(self.url, target, {**FILE, 'sha256':'a'*64}, lambda _: None)
        self.assertFalse(target.exists()); self.assertFalse(target.with_suffix('.bin.part').exists())
    def test_model_install_reuses_verified_cache_without_network_and_is_repeatable(self):
        model={'name':'narrator','repo':'test/model','revision':'pinned','files':[FILE]}
        cache=self.root/'cache'; cached=cache/'models--test--model/snapshots/pinned/weights.bin'
        cached.parent.mkdir(parents=True); cached.write_bytes(PAYLOAD)
        destination=self.root/'Models'; progress=[]
        with patch('models.urlopen', side_effect=AssertionError('No download expected')):
            install({'models':[model]}, destination, lambda **v: progress.append(v), cache=cache)
            install({'models':[model]}, destination, lambda **v: progress.append(v), cache=cache)
        self.assertEqual((destination/'narrator/weights.bin').read_bytes(),PAYLOAD)
        self.assertEqual(progress[-1]['completed'],FILE['size'])
    def test_native_frames_handle_partial_reads_and_reject_oversized_requests(self):
        value={'method':'voices'}; body=json.dumps(value).encode()
        class Fragmented(io.BytesIO):
            def read(self,n=-1): return super().read(min(n,2))
        self.assertEqual(native_host.receive(Fragmented(struct.pack('=I',len(body))+body)),value)
        with self.assertRaises(ValueError): native_host.receive(io.BytesIO(struct.pack('=I',32001)))
        with self.assertRaises(EOFError): native_host.receive(io.BytesIO(b'\0\1'))
    def test_native_host_checks_origin_before_any_engine_or_text_request(self):
        with patch.object(native_host,'ensure_engine',side_effect=AssertionError('Must not start')):
            with self.assertRaisesRegex(ValueError,'official'):
                native_host.run('chrome-extension://'+'a'*32+'/',io.BytesIO())
    def test_native_response_is_framed_and_enforces_chrome_message_limit(self):
        stream=io.BytesIO(); native_host.send({'type':'chunk','data':'AAAB'},stream)
        stream.seek(0); self.assertEqual(native_host.receive(stream),{'type':'chunk','data':'AAAB'})
        with self.assertRaises(ValueError): native_host.send({'data':'a'*(1024*1024)},io.BytesIO())

class HeartbeatTests(unittest.TestCase):
    def request(self, method, emit):
        body = json.dumps({'method': method}).encode()
        origin = f"chrome-extension://{native_host.CONNECTION['extensionId']}/"
        native_host.run(origin, io.BytesIO(struct.pack('=I', len(body)) + body), emit)

    def test_heartbeat_records_liveness_without_loading_or_polling_the_voice_engine(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(native_host, 'DIRECTORY', Path(temp)), \
             patch.object(native_host, 'ensure_engine', side_effect=AssertionError('Must not load voices')), \
             patch.object(native_host, 'health', side_effect=AssertionError('Must not poll engine')), \
             patch.object(native_host.time, 'time', return_value=1234):
            replies = []; self.request('heartbeat', replies.append)
            self.assertEqual(json.loads((Path(temp) / 'chrome-connection.json').read_text()), {
                'protocolVersion': 1, 'extensionId': native_host.CONNECTION['extensionId'], 'connectedAt': 1234})
            self.assertEqual(replies, [{'type': 'result', 'value': {'connected': True}}])

    def test_status_does_not_renew_background_liveness(self):
        with patch.object(native_host, 'write_json', side_effect=AssertionError('Only heartbeat establishes liveness')), \
             patch.object(native_host, 'health', return_value=None):
            replies = []; self.request('status', replies.append)
            self.assertEqual(replies, [{'type': 'result', 'value': {'connected': True, 'ready': False}}])

if __name__ == '__main__': unittest.main()
