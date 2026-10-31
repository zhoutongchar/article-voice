"""Persistent voice references: one recording and transcript per preset voice."""
import hashlib
import json
import wave
from dataclasses import dataclass
from pathlib import Path


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()


@dataclass(frozen=True)
class VoiceReference:
    voice: str
    transcript: str
    pcm: bytes
    identity: str


class ReferenceLibrary:
    def __init__(self, config, directory):
        self.config = config
        self.directory = Path(directory)
        self.voices = {}

    def descriptor(self, voice):
        preset = next(v for v in self.config["voices"] if v["id"] == voice)
        language = preset["language"]
        return {"voice": voice, "language": language, "model": self.config["referenceModel"],
                "revision": self.config["referenceRevision"], "version": self.config["reference"]["version"],
                "seed": self.config["reference"]["seed"], "temperature": self.config["reference"]["temperature"],
                "instruct": self.config["reference"]["instruct"], "transcript": self.config["reference"]["texts"][language]}

    def load(self, voice, create):
        descriptor = self.descriptor(voice)
        recipe = hashlib.sha256(canonical(descriptor)).hexdigest()
        directory = self.directory / recipe
        wav_path, metadata_path = directory / "reference.wav", directory / "reference.json"
        if metadata_path.exists() and wav_path.exists():
            metadata = json.loads(metadata_path.read_text())
            if metadata.get("descriptor") != descriptor:
                raise ValueError("The saved voice reference does not match its recipe")
            with wave.open(str(wav_path), "rb") as recording:
                if (recording.getnchannels(), recording.getsampwidth(), recording.getframerate()) != (1, 2, 24000):
                    raise ValueError("The saved voice reference has an invalid audio format")
                pcm = recording.readframes(recording.getnframes())
            identity = hashlib.sha256(canonical(descriptor) + pcm).hexdigest()
            if identity != metadata.get("identity"):
                raise ValueError("The saved voice reference changed; restore it or remove this generated reference folder")
        else:
            pcm = create(descriptor)
            if not isinstance(pcm, bytes) or not 3 * 48000 <= len(pcm) <= 60 * 48000 or len(pcm) % 2:
                raise ValueError("A voice reference must contain 3–60 seconds of mono 24 kHz PCM")
            identity = hashlib.sha256(canonical(descriptor) + pcm).hexdigest()
            directory.mkdir(parents=True, exist_ok=True)
            temporary = directory / "reference.wav.tmp"
            with wave.open(str(temporary), "wb") as recording:
                recording.setnchannels(1); recording.setsampwidth(2); recording.setframerate(24000)
                recording.writeframes(pcm)
            temporary.replace(wav_path)
            temporary = directory / "reference.json.tmp"
            temporary.write_text(json.dumps({"descriptor": descriptor, "identity": identity}, ensure_ascii=False, indent=2))
            temporary.replace(metadata_path)
        reference = VoiceReference(voice, descriptor["transcript"], pcm, identity)
        self.voices[voice] = reference
        return reference

    def catalog(self):
        return [{**voice, "referenceId": self.voices[voice["id"]].identity if voice["id"] in self.voices else None}
                for voice in self.config["voices"]]
