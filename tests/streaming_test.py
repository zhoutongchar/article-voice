"""Real HTTP streaming boundaries with a controlled producer; no GPU claims."""
import base64
import http.client
import json
from pathlib import Path
import sys
import threading
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "local"))
import server
from streaming import pieces


class Producer:
    def __init__(self):
        self.second = threading.Event()
        self.release = threading.Event()
        self.stopped = threading.Event()
        self.calls = 0

    def reference_identity(self, voice):
        return "a" * 64

    def generate(self, text, voice, language, cancelled):
        self.calls += 1
        if self.calls == 2:
            self.second.set()
            while not self.release.wait(.02):
                if cancelled.is_set():
                    self.stopped.set()
                    raise InterruptedError()
        return {"pcm": base64.b64encode(b"\1\0" * 2400).decode(), "duration": .1,
                "words": [{"word": text, "start": 0, "end": .1}], "sampleRate": 24000,
                **{key: server.CONFIG[key] for key in ("model", "revision", "pipeline")}, "referenceId": "a" * 64}


class StreamingTests(unittest.TestCase):
    def setUp(self):
        self.runtime = Producer()
        self.patch = patch.object(server, "runtime", self.runtime)
        self.patch.start()
        self.http = server.ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        self.thread = threading.Thread(target=self.http.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.runtime.release.set()
        self.http.shutdown(); self.http.server_close(); self.thread.join()
        self.patch.stop()

    def start(self):
        connection = http.client.HTTPConnection(*self.http.server_address, timeout=3)
        text = "A useful reader follows the actual sound, and begins before the whole article is ready. Another sentence belongs in this paragraph.\n\nThe next paragraph can arrive while the first one is playing."
        connection.request("POST", "/speech/stream", json.dumps({"text": text, "voice": "Ryan", "referenceId": "a" * 64}), {"Content-Type": "application/json"})
        response = connection.getresponse()
        self.assertEqual(response.status, 200)
        self.assertEqual(json.loads(response.readline())["type"], "start")
        return connection, response

    def test_audio_is_delivered_before_remaining_generation_finishes(self):
        connection, response = self.start()
        first = json.loads(response.readline())
        self.assertEqual(first["type"], "clip")
        self.assertEqual(first["offset"], 0)
        self.assertTrue(self.runtime.second.wait(2))
        self.assertFalse(self.runtime.release.is_set())
        self.runtime.release.set()
        rest = [json.loads(line) for line in response]
        self.assertEqual(rest[-1]["type"], "done")
        self.assertTrue(any(event["type"] == "clip" for event in rest))
        connection.close()

    def test_disconnect_cancels_remaining_generation(self):
        connection, response = self.start()
        self.assertEqual(json.loads(response.readline())["type"], "clip")
        self.assertTrue(self.runtime.second.wait(2))
        response.close(); connection.close()
        self.assertTrue(self.runtime.stopped.wait(3))

    def test_paragraph_boundaries_preserve_unicode_offsets_and_unbounded_sentences(self):
        text = "  😀 A useful reader follows the actual sound.\nA line wrap stays in this paragraph. " + "中文也可以朗读，让每个词语的位置保持准确。" * 20 + "\n\nAnother paragraph."
        source = text.encode("utf-16-le")
        previous = 0
        self.assertEqual(len(list(pieces(text))), 2)
        self.assertGreater(len(next(pieces(text))[0]), 480)
        for value, offset in pieces(text):
            length = len(value.encode("utf-16-le")) // 2
            self.assertEqual(source[offset * 2:(offset + length) * 2].decode("utf-16-le"), value)
            self.assertFalse(source[previous * 2:offset * 2].decode("utf-16-le").strip())
            previous = offset + length
        self.assertFalse(source[previous * 2:].decode("utf-16-le").strip())

    def test_long_paragraphs_split_at_sentences_without_cutting_abbreviations_or_decimals(self):
        prefix = 'x' * 1490 + '. '
        text = prefix + 'Dr. Mira kept the rate at 3.50%. Another complete sentence follows.'
        result = list(pieces(text))
        self.assertEqual([value for value, _ in result], [prefix.strip(), 'Dr. Mira kept the rate at 3.50%. Another complete sentence follows.'])
        single = 'A sentence with many words ' + 'and more words ' * 130 + 'finally ends.'
        self.assertEqual(list(pieces(single)), [(single, 0)])
        chinese = '😀第一句保持完整。第二句也应完整！' * 120
        result = list(pieces(chinese)); source = chinese.encode('utf-16-le')
        self.assertGreater(len(result), 1)
        for value, offset in result:
            size = len(value.encode('utf-16-le')) // 2
            self.assertLessEqual(size, 1500)
            self.assertEqual(source[offset * 2:(offset + size) * 2].decode('utf-16-le'), value)
            self.assertIn(value[-1], '。！')


if __name__ == "__main__":
    unittest.main()
