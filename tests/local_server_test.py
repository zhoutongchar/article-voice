"""Actual loopback HTTP boundary checks; no model inference or downloads."""
import http.client
import json
import sys
import threading
import unittest
from unittest.mock import patch
from types import SimpleNamespace
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "local"))
from server import Handler, ThreadingHTTPServer, runtime
import server as service
from streaming import RemoteRuntime


class ServerBoundaryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection(*self.server.server_address, timeout=2)
        connection.request(method, path, body, headers or {})
        response = connection.getresponse()
        result = response.status, dict(response.getheaders()), response.read()
        connection.close()
        return result

    def test_voice_catalog_is_available_without_loading_the_gpu(self):
        status, _, body = self.request("GET", "/voices")
        self.assertEqual(status, 200)
        self.assertEqual(len(json.loads(body)["voices"]), 9)

    def test_alignment_prefetch_defaults_on_and_can_be_disabled_for_local_engines(self):
        self.assertTrue(service.parse_arguments([]).prefetch_alignment)
        self.assertFalse(service.parse_arguments(['--no-prefetch-alignment']).prefetch_alignment)
        # A gateway must still start with defaults, while the upstream owns scheduling.
        self.assertEqual(service.parse_arguments(['--port', '4324', '--upstream-port', '4318']).upstream_port, 4318)
        status, _, body = self.request('GET', '/health')
        self.assertEqual(status, 200)
        self.assertTrue(json.loads(body)['alignmentPrefetch'])
        with patch.object(service, 'PREFETCH_ALIGNMENT', False):
            _, _, body = self.request('GET', '/health')
            self.assertFalse(json.loads(body)['alignmentPrefetch'])

    def test_gateway_reports_the_upstream_setting_without_claiming_an_unknown_default(self):
        remote = RemoteRuntime(4318)
        catalog = {'voices': [{**voice, 'referenceId': 'a' * 64} for voice in service.CONFIG['voices']],
                   **{key: service.CONFIG[key] for key in ('model', 'revision', 'pipeline')}}
        for reported in (True, False, None):
            health = {'ready': True, **{key: service.CONFIG[key] for key in ('model', 'revision', 'pipeline')}}
            if reported is not None: health['alignmentPrefetch'] = reported
            with patch.object(remote, '_request', side_effect=[health, catalog]): remote.load()
            with patch.object(service, 'runtime', remote):
                _, _, body = self.request('GET', '/health')
                self.assertIs(json.loads(body)['alignmentPrefetch'], reported)

    def test_other_sites_and_hosts_cannot_submit_articles_or_read_audio(self):
        for headers in ({"Origin": "https://unrelated.example"}, {"Host": "unrelated.example"}, {"Origin": "null"}):
            status, _, _ = self.request("GET", "/voices", headers=headers)
            self.assertEqual(status, 403)

    def test_expected_browser_origin_has_scoped_cors(self):
        origin = "http://127.0.0.1:4317"
        status, headers, _ = self.request("OPTIONS", "/speech", headers={"Origin": origin})
        self.assertEqual(status, 204)
        self.assertEqual(headers["Access-Control-Allow-Origin"], origin)

    def test_malformed_requests_fail_before_model_generation(self):
        for body in ({"text": [], "voice": "Ryan"}, {"text": "hello", "voice": "unknown"},
                     {"text": "hello", "voice": "Ryan", "language": "hi"},
                     {"text": "hello", "voice": "Ryan", "prepare": "false"},
                     {"text": "😀" * 6001, "voice": "Ryan"}):
            status, _, _ = self.request("POST", "/speech", json.dumps(body), {"Content-Type": "application/json"})
            self.assertEqual(status, 400)

    def test_stale_or_missing_reference_cannot_start_generation(self):
        with patch.dict(runtime.references.voices, {'Ryan': SimpleNamespace(identity='b' * 64)}):
            for reference in (None, 'a' * 64):
                body = {"text": "hello", "voice": "Ryan", "referenceId": reference}
                status, _, _ = self.request("POST", "/speech", json.dumps(body), {"Content-Type": "application/json"})
                self.assertEqual(status, 409)

    def test_full_page_preparation_and_verified_piece_reach_the_runtime_as_separate_operations(self):
        page = 'A line wraps in the mid-\ndle of a paragraph. ' * 80
        calls = []
        producer = SimpleNamespace(reference_identity=lambda voice: 'a' * 64,
            prepare=lambda text, cancelled: calls.append(('prepare', text)) or {'preparation': {'original': text}},
            generate=lambda text, voice, language, cancelled, **options: calls.append(('speech', text, options)) or {'ok': True})
        with patch.object(service, 'runtime', producer):
            status, _, _ = self.request('POST', '/prepare', json.dumps({'text': page}), {'Content-Type': 'application/json'})
            self.assertEqual(status, 200)
            selection = {'id': 'b' * 64, 'original': page, 'start': 0, 'end': len(page)}
            status, _, _ = self.request('POST', '/speech', json.dumps({'text': page, 'voice': 'Ryan', 'referenceId': 'a' * 64,
                                                                     'preparation': selection}), {'Content-Type': 'application/json'})
            self.assertEqual(status, 200)
        self.assertEqual(calls, [('prepare', page), ('speech', page, {'preparation': selection})])
        for text in ('', [], '😀' * 6001):
            status, _, _ = self.request('POST', '/prepare', json.dumps({'text': text}), {'Content-Type': 'application/json'})
            self.assertEqual(status, 400)


if __name__ == "__main__":
    unittest.main()
