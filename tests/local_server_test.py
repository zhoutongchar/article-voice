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
                     {"text": "x" * 2501, "voice": "Ryan"}):
            status, _, _ = self.request("POST", "/speech", json.dumps(body), {"Content-Type": "application/json"})
            self.assertEqual(status, 400)

    def test_stale_or_missing_reference_cannot_start_generation(self):
        with patch.dict(runtime.references.voices, {'Ryan': SimpleNamespace(identity='b' * 64)}):
            for reference in (None, 'a' * 64):
                body = {"text": "hello", "voice": "Ryan", "referenceId": reference}
                status, _, _ = self.request("POST", "/speech", json.dumps(body), {"Content-Type": "application/json"})
                self.assertEqual(status, 409)


if __name__ == "__main__":
    unittest.main()
