"""Real contract/cache/executor boundaries with controlled model implementations."""
import copy
import http.client
import json
import sys
import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from collections import OrderedDict
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'local'))
from contracts import artifact, content, speech, digest, transform, alignment, PipelineError
from runtime import SpeechRuntime, CONFIG
from references import ReferenceLibrary
from text_cleanup import TextFormatter, source_spans
from stage_executor import StageExecutor
from artifact_store import ArtifactStore


def original(text='A complete paragraph.'):
    return artifact('content', parentIds=[], streamId='book', sequence=0, stability='sealed', text=text,
                    paragraphs=[{'start': 0, 'end': len(text.encode('utf-16-le')) // 2}],
                    sourceMap=[{'start': 0, 'end': len(text.encode('utf-16-le')) // 2, 'identity': True,
                                'sources': [{'unitId': 'page', 'revision': 'page-v1', 'block': 0, 'start': 0, 'end': len(text.encode('utf-16-le')) // 2}]}])


def spoken(text='A complete paragraph.'):
    return artifact('speech', parentId=original(text)['id'], sequence=0, text=text, textDigest=digest(text), range={'start': 0, 'end': len(text.encode('utf-16-le')) // 2}, policy='fixture')

class PipelineTests(unittest.TestCase):
    def runtime(self, directory, calls, enabled=True):
        import mlx.core as mx
        import numpy as np
        runtime = SpeechRuntime(directory, formatter_enabled=enabled)
        runtime.references = ReferenceLibrary(CONFIG, Path(directory) / 'refs'); runtime.references.load('Ryan', lambda _: b'\1\0' * 72000)
        runtime.reference_audio['Ryan'] = mx.array(np.zeros(72000, dtype=np.float32))
        def generate(**options):
            calls.append('speech'); yield SimpleNamespace(audio=mx.array(np.zeros(24000, dtype=np.float32)), token_count=12)
        def align(audio, **options):
            calls.append('align'); return [SimpleNamespace(text=options['text'], start_time=0, end_time=.8)]
        runtime.tts = SimpleNamespace(generate=generate, sample_rate=24000); runtime.aligner = SimpleNamespace(generate=align)
        return runtime

    def test_formatter_loading_does_not_require_narrator_or_aligner_initialization(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime = SpeechRuntime(directory)
            formatter = object.__new__(TextFormatter); formatter.cache = OrderedDict(); formatter.infer = lambda text, cancelled=None: (text, None)
            with patch.object(runtime, '_load', side_effect=AssertionError('Must not load voices')), patch.object(runtime, 'model_path', return_value='formatter-only'), patch('runtime.TextFormatter', return_value=formatter):
                result = runtime.format_content(original())
            self.assertEqual(result['status'], 'completed'); self.assertIsNone(runtime.tts); self.assertIsNone(runtime.aligner)

    def test_formatter_absence_does_not_block_readiness_speech_alignment_or_cache_reuse(self):
        with tempfile.TemporaryDirectory() as directory:
            calls = []; runtime = self.runtime(directory, calls, enabled=False)
            self.assertTrue(runtime.ready); self.assertIsNone(runtime.formatter)
            chunk = original(); result = runtime.format_content(chunk)
            self.assertEqual(result['status'], 'bypassed'); self.assertIs(result['output'], chunk)
            request = spoken(); sound = runtime.synthesize(request, 'Ryan', 'en'); timed = runtime.align(request, sound['output'], 'en')
            self.assertEqual(timed['output']['words'][0]['range'], {'start': 0, 'end': len(request['text']) - 1})
            self.assertEqual(timed['output']['unmapped'][-1], {'start': len(request['text']) - 1, 'end': len(request['text'])})
            self.assertEqual(calls, ['speech', 'align']); self.assertIsNone(runtime.formatter)
            other = self.runtime(directory, calls, enabled=False)
            self.assertTrue(other.synthesize(request, 'Ryan', 'en')['cached']); self.assertTrue(other.align(request, sound['output'], 'en')['cached'])
            with patch.dict(CONFIG, {'alignerRevision': 'another-aligner'}):
                self.assertTrue(other.synthesize(request, 'Ryan', 'en')['cached'])
                self.assertFalse(other.align(request, sound['output'], 'en')['cached'])
            self.assertEqual(calls, ['speech', 'align', 'align'])

    def test_transform_keeps_content_maps_and_speech_and_alignment_reject_identity_mismatches(self):
        raw = original('😀 A re-\nmarkable paragraph.'); prepared = '😀 A remarkable paragraph.'
        result = transform(raw, {'text': prepared, 'spans': source_spans(raw['text'], prepared)})
        content(result); self.assertEqual(result['parentIds'], [raw['id']]); self.assertEqual(result['text'], prepared)
        changed = copy.deepcopy(result); changed['text'] += 'changed'
        with self.assertRaisesRegex(PipelineError, 'identity changed'): content(changed)
        with tempfile.TemporaryDirectory() as directory:
            runtime = self.runtime(directory, [], enabled=False); sound = runtime.synthesize(spoken(), 'Ryan', 'en')['output']
            with self.assertRaisesRegex(PipelineError, 'different text'): runtime.align(spoken('Different text.'), sound)

    def test_expired_audio_is_explicit_and_bounded_cache_does_not_invent_alignment(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime = self.runtime(directory, [], enabled=False); runtime.store.max_bytes = 1
            request = spoken(); sound = runtime.synthesize(request, 'Ryan', 'en')['output']
            with self.assertRaises(PipelineError) as raised: runtime.align(request, sound)
            self.assertEqual(raised.exception.code, 'ARTIFACT_EXPIRED'); self.assertTrue(raised.exception.retryable)

    def test_reader_alignment_prefetch_reuses_independent_artifacts_without_waiting_on_its_gpu_owner(self):
        with tempfile.TemporaryDirectory() as directory:
            calls = []; runtime = self.runtime(directory, calls, enabled=False); executor = StageExecutor()
            runtime.executor = executor
            try:
                request = spoken(); sound = runtime.synthesize(request, 'Ryan', 'en', prefetch_alignment=True)
                self.assertFalse(sound['cached']); self.assertEqual(calls, ['speech', 'align'])
                timed = runtime.align(request, sound['output'], 'en')
                self.assertTrue(timed['cached']); alignment(timed['output'], request, sound['output'])
                self.assertTrue(runtime.synthesize(request, 'Ryan', 'en', prefetch_alignment=True)['cached'])
                self.assertEqual(calls, ['speech', 'align'])
                for failure in (ValueError, RuntimeError):
                    def failed(*args, **options): raise failure('invalid measured timestamps')
                    runtime.aligner.generate = failed
                    other = spoken(f'A different complete paragraph for {failure.__name__}.')
                    valid_audio = runtime.synthesize(other, 'Ryan', 'en', prefetch_alignment=True)
                    self.assertEqual(valid_audio['output']['textDigest'], other['textDigest'])
                    with self.assertRaisesRegex(failure, 'invalid measured timestamps'): runtime.align(other, valid_audio['output'], 'en')
            finally: executor.shutdown(cancel_futures=True)

    def test_prefetched_alignment_is_available_while_the_next_speech_job_owns_the_gpu(self):
        with tempfile.TemporaryDirectory() as directory:
            calls = []; runtime = self.runtime(directory, calls, enabled=False); executor = StageExecutor()
            runtime.executor = executor
            entered = threading.Event(); release = threading.Event(); second = threading.Event(); finish = threading.Event()
            generate = runtime.tts.generate
            def gated(**options):
                if options['text'].startswith('First'):
                    entered.set(); release.wait(3)
                else: second.set(); finish.wait(3)
                yield from generate(**options)
            runtime.tts.generate = gated
            pool = ThreadPoolExecutor(2)
            first_text, second_text = spoken('First paragraph.'), spoken('Second paragraph.')
            try:
                first_job = pool.submit(runtime.synthesize, first_text, 'Ryan', 'en', prefetch_alignment=True)
                self.assertTrue(entered.wait(1))
                next_job = pool.submit(runtime.synthesize, second_text, 'Ryan', 'en', prefetch_alignment=True)
                deadline = time.monotonic() + 1
                while executor.waiting.qsize() != 1 and time.monotonic() < deadline: time.sleep(.001)
                self.assertEqual(executor.waiting.qsize(), 1)
                release.set(); self.assertTrue(second.wait(2))
                sound = first_job.result(1)
                self.assertTrue(runtime.align(first_text, sound['output'], 'en')['cached'])
                self.assertFalse(next_job.done())
                finish.set(); next_job.result(2)
            finally: release.set(); finish.set(); pool.shutdown(wait=True); executor.shutdown(cancel_futures=True)

    def test_cancel_during_alignment_prefetch_preserves_audio_without_publishing_a_late_result(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime = self.runtime(directory, [], enabled=False); executor = StageExecutor(); runtime.executor = executor
            cancelled = threading.Event(); put_audio = runtime.store.put_audio
            def saved(*args): put_audio(*args); cancelled.set()
            runtime.store.put_audio = saved
            try:
                request = spoken()
                with self.assertRaises(InterruptedError): runtime.synthesize(request, 'Ryan', 'en', cancelled, prefetch_alignment=True)
                cached = runtime.synthesize(request, 'Ryan', 'en')
                self.assertTrue(cached['cached'])
                self.assertFalse(runtime.align(request, cached['output'], 'en')['cached'])
            finally: executor.shutdown(cancel_futures=True)

    def test_real_http_stages_support_identity_formatting_and_reject_mismatched_artifacts(self):
        import server
        with tempfile.TemporaryDirectory() as directory:
            calls = []; runtime = self.runtime(directory, calls, enabled=False)
            http_server = server.ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
            thread = threading.Thread(target=http_server.serve_forever, daemon=True); thread.start()
            def post(path, body):
                connection = http.client.HTTPConnection(*http_server.server_address, timeout=3)
                connection.request('POST', '/pipeline/' + path, json.dumps(body), {'Content-Type': 'application/json'})
                response = connection.getresponse(); result = response.status, json.loads(response.read()); connection.close(); return result
            try:
                with patch.object(server, 'runtime', runtime):
                    status, result = post('format', {'content': original(), 'enabled': False})
                    self.assertEqual(status, 200); self.assertEqual(result['status'], 'bypassed')
                    request = spoken(); reference = runtime.reference_identity('Ryan')
                    status, sound = post('synthesize', {'speech': request, 'voice': 'Ryan', 'referenceId': reference})
                    self.assertEqual(status, 200)
                    status, timed = post('align', {'speech': request, 'audio': sound['output']})
                    self.assertEqual(status, 200); self.assertEqual(timed['output']['audioId'], sound['output']['id'])
                    self.assertTrue(timed['cached'])
                    status, failure = post('align', {'speech': spoken('Different text.'), 'audio': sound['output']})
                    self.assertEqual(status, 400); self.assertEqual(failure['code'], 'INPUT_MISMATCH')
                    invalid = dict(request, text='tampered')
                    status, failure = post('synthesize', {'speech': invalid, 'voice': 'Ryan', 'referenceId': reference})
                    self.assertEqual(status, 400); self.assertEqual(failure['code'], 'INVALID_ARTIFACT')
                    self.assertEqual(calls, ['speech', 'align'])
            finally: http_server.shutdown(); http_server.server_close(); thread.join()

    def test_gpu_executor_has_one_owner_and_prioritizes_pending_foreground_work(self):
        executor = StageExecutor(); entered = threading.Event(); release = threading.Event(); order = []
        try:
            first = executor.submit(lambda: (entered.set(), release.wait(3)))
            self.assertTrue(entered.wait(1))
            background = executor.submit(lambda: order.append('background'), priority=1)
            cancelled = executor.submit(lambda: order.append('cancelled')); cancelled.cancel()
            foreground = executor.submit(lambda: order.append('foreground'))
            release.set(); first.result(2); foreground.result(2); background.result(2)
            self.assertEqual(order, ['foreground', 'background'])
        finally: release.set(); executor.shutdown(cancel_futures=True)

if __name__ == '__main__': unittest.main()
