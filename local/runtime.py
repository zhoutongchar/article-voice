"""Apple Silicon speech and measured word alignment. No cloud inference."""
import base64
import json
import math
import re
import time
from pathlib import Path
from references import ReferenceLibrary

CONFIG = json.loads(Path(__file__).with_name("config.json").read_text())


class SpeechRuntime:
    def __init__(self, data_directory=None, models_directory=None):
        self.tts = self.aligner = None
        directory = Path(data_directory) if data_directory else Path(__file__).resolve().parents[1] / ".cache"
        self.references = ReferenceLibrary(CONFIG, directory / "voice-references")
        self.reference_audio = {}
        self.models_directory = Path(models_directory) if models_directory else None

    @property
    def ready(self):
        return self.tts is not None and self.aligner is not None

    def catalog(self):
        return self.references.catalog()

    def reference_identity(self, voice):
        reference = self.references.voices.get(voice)
        return reference.identity if reference else None

    def load(self):
        from huggingface_hub import snapshot_download
        from huggingface_hub.errors import LocalEntryNotFoundError
        from mlx_audio.tts.utils import load_model
        from mlx_audio.stt import load
        import mlx.core as mx
        import numpy as np
        def model_path(repo, revision):
            if self.models_directory and repo in (CONFIG["model"], CONFIG["aligner"]):
                return str(self.models_directory / ("narrator" if repo == CONFIG["model"] else "aligner"))
            try:
                return snapshot_download(repo, revision=revision, local_files_only=True)
            except LocalEntryNotFoundError:
                return snapshot_download(repo, revision=revision)
        tts_path = model_path(CONFIG["model"], CONFIG["revision"])
        aligner_path = model_path(CONFIG["aligner"], CONFIG["alignerRevision"])
        reference_model = None
        def create_reference(descriptor):
            nonlocal reference_model
            if reference_model is None:
                reference_model = load_model(model_path(CONFIG["referenceModel"], CONFIG["referenceRevision"]))
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
        self.aligner = load(aligner_path)

    def generate(self, text, voice, language, cancelled=None):
        import mlx.core as mx
        import numpy as np
        from scipy.signal import resample_poly
        started = time.perf_counter()
        if self.tts is None:
            self.load()
        reference = self.references.voices[voice]
        chunks = []
        generated_tokens = 0
        # Streaming yields let Stop discard the remaining work after a short chunk.
        for result in self.tts.generate(text=text, ref_audio=self.reference_audio[voice], ref_text=reference.transcript,
                                        lang_code=CONFIG["languages"].get(language, "auto"), **CONFIG["generation"],
                                        stream=True, streaming_interval=1.0, max_tokens=1600, verbose=False):
            if cancelled and cancelled.is_set():
                raise InterruptedError("Reading cancelled")
            generated_tokens += result.token_count
            chunks.append(np.array(result.audio, dtype=np.float32).reshape(-1))
        if generated_tokens >= 1600:
            raise ValueError("This passage reached the local generation limit; choose a shorter selection")
        if not chunks:
            raise ValueError("Qwen did not generate audio")
        audio = np.concatenate(chunks)
        rate = self.tts.sample_rate
        if rate != 24000:
            divisor = math.gcd(rate, 24000)
            audio = resample_poly(audio, 24000 // divisor, rate // divisor)
        if not np.isfinite(audio).all() or not len(audio):
            raise ValueError("Qwen returned invalid audio")
        if cancelled and cancelled.is_set():
            raise InterruptedError("Reading cancelled")
        duration = len(audio) / 24000
        # The aligner accepts 16 kHz samples. Its times refer to the actual audio,
        # rather than evenly dividing duration among the words.
        align_language = CONFIG["languages"].get(language)
        if not align_language:
            align_language = "Japanese" if re.search(r"[\u3040-\u30ff]", text) else "Korean" if re.search(r"[\uac00-\ud7af]", text) else "Chinese" if re.search(r"[\u3400-\u9fff]", text) else "English"
        aligned = self.aligner.generate(resample_poly(audio, 2, 3).astype(np.float32), text=text, language=align_language)
        words = []
        previous = 0
        for item in aligned:
            start, end = float(item.start_time), float(item.end_time)
            if not (math.isfinite(start) and math.isfinite(end) and previous <= start <= end <= duration + .05):
                raise ValueError("The local aligner returned invalid word timestamps")
            words.append({"word": item.text, "start": start, "end": min(end, duration)})
            previous = start
        if not words:
            raise ValueError("The local aligner could not locate words in this passage")
        pcm = (np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes()
        mx.clear_cache()
        return {"pcm": base64.b64encode(pcm).decode("ascii"), "duration": duration, "words": words,
                "sampleRate": 24000, "model": CONFIG["model"], "revision": CONFIG["revision"],
                "pipeline": CONFIG["pipeline"], "referenceId": reference.identity, "elapsed": time.perf_counter() - started}
