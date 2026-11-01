"""Apple Silicon speech and measured word alignment. No cloud inference."""
import base64
import json
import math
import re
import time
import threading
from pathlib import Path
from references import ReferenceLibrary
from text_cleanup import TextFormatter, MODEL as FORMATTER_MODEL, REVISION as FORMATTER_REVISION, preparation_identity, source_spans, POLICY

CONFIG = json.loads(Path(__file__).with_name("config.json").read_text())


MAX_SPEECH_TOKENS = 4096  # About 5.5 minutes at the model's 12 Hz codec rate.


from artifact_store import ArtifactStore
from contracts import artifact, content, speech, audio as validate_audio, alignment, digest, identity, transform, locate_words, PipelineError


class SpeechRuntime:
    def __init__(self, data_directory=None, models_directory=None, executor=None, formatter_enabled=True):
        self.tts = self.aligner = self.formatter = None
        directory = Path(data_directory) if data_directory else Path(__file__).resolve().parents[1] / ".cache"
        self.references = ReferenceLibrary(CONFIG, directory / "voice-references")
        self.reference_audio = {}
        self.store = ArtifactStore(directory / "pipeline-cache")
        self.executor = executor
        self.formatter_enabled = formatter_enabled
        self.model_lock = threading.RLock()
        self.models_directory = Path(models_directory) if models_directory else None

    @property
    def ready(self):
        return self.tts is not None and self.aligner is not None

    @property
    def formatter_loaded(self):
        return self.formatter is not None

    def catalog(self):
        return self.references.catalog()

    def reference_identity(self, voice):
        reference = self.references.voices.get(voice)
        return reference.identity if reference else None

    def model_path(self, repo, revision):
        from huggingface_hub import snapshot_download
        from huggingface_hub.errors import LocalEntryNotFoundError
        names = {CONFIG['model']: 'narrator', CONFIG['aligner']: 'aligner', FORMATTER_MODEL: 'formatter'}
        if self.models_directory and repo in names: return str(self.models_directory / names[repo])
        try: return snapshot_download(repo, revision=revision, local_files_only=True)
        except LocalEntryNotFoundError: return snapshot_download(repo, revision=revision)

    def _load_tts(self):
        if self.tts is not None: return
        from mlx_audio.tts.utils import load_model
        import mlx.core as mx
        import numpy as np
        tts_path = self.model_path(CONFIG["model"], CONFIG["revision"])
        reference_model = None
        def create_reference(descriptor):
            nonlocal reference_model
            if reference_model is None:
                reference_model = load_model(self.model_path(CONFIG["referenceModel"], CONFIG["referenceRevision"]))
            print(f"Preparing permanent reference for {descriptor['voice']}…", flush=True)
            mx.random.seed(descriptor["seed"])
            chunks, tokens = [], 0
            for result in reference_model.generate(text=descriptor["transcript"], voice=descriptor["voice"],
                    lang_code=CONFIG["languages"][descriptor["language"]], instruct=descriptor["instruct"],
                    temperature=descriptor["temperature"], stream=True, streaming_interval=1, max_tokens=750, verbose=False):
                tokens += result.token_count
                chunks.append(np.array(result.audio, dtype=np.float32).reshape(-1))
            if tokens >= 750 or not chunks:
                raise ValueError("The reference voice could not finish its sample")
            audio = np.concatenate(chunks)
            if not np.isfinite(audio).all() or np.max(np.abs(audio)) < .001:
                raise ValueError("The reference voice returned invalid or silent audio")
            return (np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes()
        for voice in CONFIG["voices"]:
            reference = self.references.load(voice["id"], create_reference)
            self.reference_audio[voice["id"]] = mx.array(np.frombuffer(reference.pcm, dtype="<i2").astype(np.float32) / 32768)
        # The preset model is used only when a permanent reference is missing.
        # Release it before loading the Base model used for article narration.
        reference_model = None
        mx.clear_cache()
        self.tts = load_model(tts_path)
    def _load_aligner(self):
        if self.aligner is not None: return
        from mlx_audio.stt import load
        self.aligner = load(self.model_path(CONFIG['aligner'], CONFIG['alignerRevision']))

    def _load(self):
        self._load_tts(); self._load_aligner()

    def gpu(self, operation, cancelled=None, priority=0):
        def run():
            if cancelled and cancelled.is_set(): raise InterruptedError('Reading cancelled')
            with self.model_lock: return operation()
        if self.executor is None: return run()
        future = self.executor.submit(run, priority=priority)
        while True:
            from concurrent.futures import TimeoutError
            try: return future.result(timeout=.1)
            except TimeoutError:
                if cancelled and cancelled.is_set(): future.cancel(); raise InterruptedError('Reading cancelled')

    def load(self):
        self.gpu(self._load)

    def _formatter(self):
        if not self.formatter_enabled: return None
        if self.formatter is None:
            if not CONFIG['pipeline'].endswith(preparation_identity()[:12]):
                raise ValueError('The formatting recipe changed. Rebuild Article Voice before formatting text.')
            self.formatter = TextFormatter(self.model_path(FORMATTER_MODEL, FORMATTER_REVISION))
        return self.formatter

    def prepare(self, text, cancelled=None):
        def run():
            formatter = self._formatter()
            if formatter is None:
                return {'original': text, 'text': text, 'spans': source_spans(text, text), 'status': 'bypassed', 'elapsed': 0}
            return formatter.prepare(text, cancelled)
        return {'preparation': self.gpu(run, cancelled), **{key: CONFIG[key] for key in ('model', 'revision', 'pipeline')}}

    def format_content(self, chunk, enabled=True, cancelled=None, priority=0):
        content(chunk)
        started = time.perf_counter()
        if not enabled or not self.formatter_enabled:
            return {'schemaVersion': 1, 'stage': 'format', 'status': 'bypassed', 'inputIds': [chunk['id']], 'output': chunk, 'elapsed': 0}
        def run():
            formatter = self._formatter()
            record = formatter.prepare(chunk['text'], cancelled)
            return record, transform(chunk, record)
        record, result = self.gpu(run, cancelled, priority)
        return {'schemaVersion': 1, 'stage': 'format', 'status': 'rejected' if record['status'] == 'rejected' else 'completed',
                'inputIds': [chunk['id']], 'output': result, 'elapsed': time.perf_counter() - started,
                'cached': record['cached'], 'reason': record.get('reason'), 'formatterId': record['identity']}

    def synthesize(self, chunk, voice, language, cancelled=None, priority=0):
        speech(chunk)
        reference = self.references.voices[voice]
        key = identity({'textDigest': chunk['textDigest'], 'referenceId': reference.identity, 'modelRevision': CONFIG['revision'],
                        'generation': CONFIG['generation'], 'language': language, 'sampleRate': 24000})
        started = time.perf_counter()
        def run():
            cached = self.store.speech(key)
            if cached: return cached, True
            if self.tts is None: self._load_tts()
            pcm = self._synthesize(chunk['text'], voice, language, cancelled)
            value = artifact('audio', textDigest=chunk['textDigest'], format='pcm_s16le', sampleRate=24000, channels=1,
                             frames=len(pcm) // 2, pcmDigest=digest(pcm), voiceId=voice, referenceId=reference.identity,
                             modelRevision=CONFIG['revision'], generationId=identity({'generation': CONFIG['generation'], 'language': language}))
            self.store.put_audio(key, value, pcm)
            return (value, pcm), False
        cached = self.store.speech(key)
        (value, pcm), hit = (cached, True) if cached else self.gpu(run, cancelled, priority)
        return {'schemaVersion': 1, 'stage': 'synthesize', 'status': 'completed', 'inputIds': [chunk['id']], 'output': value,
                'pcm': base64.b64encode(pcm).decode('ascii'), 'cached': hit, 'elapsed': time.perf_counter() - started}

    def _synthesize(self, spoken, voice, language, cancelled):
        import numpy as np
        from scipy.signal import resample_poly
        reference = self.references.voices[voice]
        chunks, generated_tokens = [], 0
        for result in self.tts.generate(text=spoken, ref_audio=self.reference_audio[voice], ref_text=reference.transcript,
                lang_code=CONFIG['languages'].get(language, 'auto'), **CONFIG['generation'],
                stream=True, streaming_interval=1.0, max_tokens=MAX_SPEECH_TOKENS, split_pattern='', verbose=False):
            if cancelled and cancelled.is_set(): raise InterruptedError('Reading cancelled')
            generated_tokens += result.token_count
            chunks.append(np.array(result.audio, dtype=np.float32).reshape(-1))
        if generated_tokens >= MAX_SPEECH_TOKENS:
            raise ValueError('This paragraph exceeds the local audio limit. Choose a shorter selection; no partial paragraph was played.')
        if not chunks: raise ValueError('Qwen did not generate audio')
        samples = np.concatenate(chunks)
        if self.tts.sample_rate != 24000:
            divisor = math.gcd(self.tts.sample_rate, 24000)
            samples = resample_poly(samples, 24000 // divisor, self.tts.sample_rate // divisor)
        if not len(samples) or not np.isfinite(samples).all(): raise ValueError('Qwen returned invalid audio')
        if cancelled and cancelled.is_set(): raise InterruptedError('Reading cancelled')
        return (np.clip(samples, -1, 1) * 32767).astype('<i2').tobytes()

    def align(self, chunk, sound, language='', cancelled=None, priority=0):
        speech(chunk); validate_audio(sound)
        if chunk['textDigest'] != sound['textDigest']: raise PipelineError('INPUT_MISMATCH', 'The audio belongs to different text.', 'align')
        key = identity({'audioId': sound['id'], 'textDigest': chunk['textDigest'], 'alignerRevision': CONFIG['alignerRevision'], 'language': language})
        started = time.perf_counter()
        def run():
            cached = self.store.read('alignment', key)
            if cached: return alignment(cached, chunk, sound), True
            value, pcm = self.store.get_audio(sound['id'])
            if value != sound: raise PipelineError('INPUT_MISMATCH', 'The audio artifact changed.', 'align')
            if self.aligner is None: self._load_aligner()
            measured = self._align(chunk['text'], pcm, language, cancelled)
            result = alignment(locate_words(chunk['text'], measured, sound['frames'], sound['sampleRate'], sound['id'], CONFIG['alignerRevision']), chunk, sound)
            self.store.write('alignment', key, result)
            return result, False
        cached = self.store.read('alignment', key)
        value, hit = (alignment(cached, chunk, sound), True) if cached else self.gpu(run, cancelled, priority)
        return {'schemaVersion': 1, 'stage': 'align', 'status': 'completed', 'inputIds': [chunk['id'], sound['id']],
                'output': value, 'cached': hit, 'elapsed': time.perf_counter() - started}

    def _align(self, spoken, pcm, language, cancelled):
        import numpy as np
        from scipy.signal import resample_poly
        if cancelled and cancelled.is_set(): raise InterruptedError('Reading cancelled')
        align_language = CONFIG['languages'].get(language)
        if not align_language:
            align_language = 'Japanese' if re.search(r'[\u3040-\u30ff]', spoken) else 'Korean' if re.search(r'[\uac00-\ud7af]', spoken) else 'Chinese' if re.search(r'[\u3400-\u9fff]', spoken) else 'English'
        samples = np.frombuffer(pcm, dtype='<i2').astype(np.float32) / 32768
        aligned = self.aligner.generate(resample_poly(samples, 2, 3).astype(np.float32), text=spoken, language=align_language)
        previous, words, duration = 0, [], len(pcm) / 48000
        for item in aligned:
            start, end = float(item.start_time), float(item.end_time)
            if not (math.isfinite(start) and math.isfinite(end) and previous <= start <= end <= duration + .05): raise ValueError('The local aligner returned invalid word timestamps')
            words.append({'word': item.text, 'start': start, 'end': min(end, duration)}); previous = start
        if cancelled and cancelled.is_set(): raise InterruptedError('Reading cancelled')
        if not words: raise ValueError('The local aligner could not locate words in this passage')
        return words

    def generate(self, text, voice, language, cancelled=None, prepare=True, preparation=None):
        # Adapter for the native Swift reader and comparison endpoint. Chrome
        # uses the independent artifact stages, without a formatter token.
        started = time.perf_counter()
        if preparation is not None:
            record = self.gpu(lambda: self._formatter().piece(text, preparation, cancelled), cancelled)
            spoken = text
        elif prepare:
            record = self.prepare(text, cancelled)['preparation']; spoken = record['text']
        else:
            spoken = text; record = {'original': text, 'text': text, 'status': 'bypassed', 'elapsed': 0}
        chunk = artifact('speech', parentId=identity({'text': text}), sequence=0, text=spoken, textDigest=digest(spoken), range={'start': 0, 'end': len(spoken.encode('utf-16-le')) // 2}, policy='legacy-adapter-v1')
        sound = self.synthesize(chunk, voice, language, cancelled)
        timed = self.align(chunk, sound['output'], language, cancelled)
        value = timed['output']
        return {'pcm': sound['pcm'], 'duration': sound['output']['frames'] / 24000, 'sampleRate': 24000,
                'words': [{'word': w['text'], 'start': w['startSample'] / 24000, 'end': w['endSample'] / 24000} for w in value['words']],
                **{key: CONFIG[key] for key in ('model', 'revision', 'pipeline')}, 'referenceId': sound['output']['referenceId'],
                'elapsed': time.perf_counter() - started, 'preparation': record,
                'timings': {'prepare': record['elapsed'], 'speech': sound['elapsed'], 'align': timed['elapsed']}}
