"""Reference identity, persistence and runtime conditioning regressions."""
import copy
import sys
import tempfile
import unittest
from collections import OrderedDict
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "local"))
from references import ReferenceLibrary
from runtime import CONFIG, SpeechRuntime
from text_cleanup import TextFormatter


class ReferenceTests(unittest.TestCase):
    def test_reference_is_created_once_and_survives_a_server_restart(self):
        with tempfile.TemporaryDirectory() as directory:
            calls = []
            def create(descriptor):
                calls.append(descriptor)
                return b'\1\0' * 72000
            first = ReferenceLibrary(CONFIG, directory).load("Ryan", create)
            second = ReferenceLibrary(CONFIG, directory).load("Ryan", create)
            self.assertEqual(len(calls), 1)
            self.assertEqual(first, second)
            self.assertEqual(len(first.identity), 64)

    def test_identity_covers_the_speaker_recipe_and_recording(self):
        with tempfile.TemporaryDirectory() as directory:
            library = ReferenceLibrary(CONFIG, directory)
            first = library.load("Ryan", lambda _: b'\1\0' * 72000)
            other = library.load("Aiden", lambda _: b'\1\0' * 72000)
            config = copy.deepcopy(CONFIG)
            config["reference"]["instruct"] = "A different reference style"
            changed = ReferenceLibrary(config, directory).load("Ryan", lambda _: b'\1\0' * 72000)
            self.assertNotEqual(first.identity, other.identity)
            self.assertNotEqual(first.identity, changed.identity)
            self.assertEqual(len(list(Path(directory).glob('*/reference.wav'))), 3)

    def test_changed_saved_audio_is_detected_instead_of_silently_changing_the_voice(self):
        with tempfile.TemporaryDirectory() as directory:
            library = ReferenceLibrary(CONFIG, directory)
            library.load("Ryan", lambda _: b'\1\0' * 72000)
            path = next(Path(directory).glob('*/reference.wav'))
            data = bytearray(path.read_bytes()); data[-1] ^= 1; path.write_bytes(data)
            with self.assertRaisesRegex(ValueError, 'reference changed'):
                ReferenceLibrary(CONFIG, directory).load("Ryan", lambda _: self.fail('Must not replace a changed saved voice'))

    def test_invalid_reference_audio_is_not_saved(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError, '3–60 seconds'):
                ReferenceLibrary(CONFIG, directory).load("Ryan", lambda _: b'\0\0')
            self.assertFalse(list(Path(directory).rglob('*.json')))

    def test_every_paragraph_conditions_the_base_model_on_the_same_audio_and_transcript(self):
        import mlx.core as mx
        import numpy as np
        with tempfile.TemporaryDirectory() as directory:
            runtime = SpeechRuntime()
            runtime.references = ReferenceLibrary(CONFIG, directory)
            reference = runtime.references.load("Ryan", lambda _: b'\1\0' * 72000)
            runtime.reference_audio["Ryan"] = mx.array(np.zeros(72000, dtype=np.float32))
            calls = []
            def generate(**kwargs):
                calls.append(kwargs)
                yield SimpleNamespace(audio=mx.array(np.zeros(24000, dtype=np.float32)), token_count=12)
            runtime.tts = SimpleNamespace(generate=generate, sample_rate=24000)
            runtime.aligner = SimpleNamespace(generate=lambda audio, **kwargs: [SimpleNamespace(text=kwargs['text'], start_time=0, end_time=.8)])
            runtime.formatter = object.__new__(TextFormatter)
            runtime.formatter.cache = OrderedDict()
            prepared = []
            def infer(text, cancelled=None):
                prepared.append(text)
                return text.replace('paragraph .', 'paragraph.'), None
            runtime.formatter.infer = infer
            for text in ('First paragraph .', 'Second paragraph .', 'Third paragraph .'):
                result = runtime.generate(text, 'Ryan', 'en')
                self.assertEqual(result['referenceId'], reference.identity)
                self.assertEqual(result['preparation']['status'], 'formatted')
                self.assertEqual(result['words'][0]['word'], text.replace('paragraph .', 'paragraph.'))
            self.assertEqual(len(calls), 3)
            self.assertEqual(prepared, ['First paragraph .', 'Second paragraph .', 'Third paragraph .'])
            for call in calls:
                self.assertTrue(call['text'].endswith('paragraph.'))
                self.assertIs(call['ref_audio'], runtime.reference_audio['Ryan'])
                self.assertEqual(call['ref_text'], reference.transcript)
                self.assertNotIn('voice', call, 'Base cloning must not receive a preset speaker name')


if __name__ == '__main__':
    unittest.main()
