"""Run the isolated HTML → small LLM → Qwen TTS → aligner experiment.

Use the separate .cache/cleanup-venv; the installed voice engine is not changed.
Input: [{"text": "state st", "math": [{"start": 6, "end": 8, "tex": "s_t"}]}]
All offsets are UTF-16. Output contains original text; keep private inputs local.
"""
import argparse
import base64
import json
import sys
import time
import wave
from pathlib import Path
from urllib.request import ProxyHandler, Request, build_opener

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "local"))
from text_cleanup import MODEL, REVISION, TextFormatter


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    parser.add_argument("--output", type=Path, default=ROOT / ".cache/text-cleanup")
    parser.add_argument("--speech", action="store_true", help="Generate original and prepared audio with the existing local voice engine")
    parser.add_argument("--port", type=int, default=json.loads((ROOT / 'chrome/connection.json').read_text())["port"])
    parser.add_argument("--limit", type=int, default=3)
    args = parser.parse_args()
    from huggingface_hub import snapshot_download
    model_path = snapshot_download(MODEL, revision=REVISION, allow_patterns=["*.json", "*.safetensors", "*.jinja", "*.txt", "README.md", "LICENSE"])
    started = time.perf_counter(); formatter = TextFormatter(model_path)
    loaded = time.perf_counter() - started
    inputs = json.loads(args.input.read_text())
    if not isinstance(inputs, list) or not 1 <= args.limit <= 20:
        parser.error("Expected an array of passages; choose a limit from 1 to 20")
    args.output.mkdir(parents=True, exist_ok=True)
    http = build_opener(ProxyHandler({}))

    def request(path, data=None):
        headers = {"Content-Type": "application/json"} if data else {}
        req = Request(f"http://127.0.0.1:{args.port}" + path, data=json.dumps(data).encode() if data else None, headers=headers)
        with http.open(req, timeout=180) as response:
            return json.load(response)

    voice = None
    if args.speech:
        if not request("/health").get("ready"):
            raise RuntimeError("Start the existing local voice engine first")
        voice = next(v for v in request("/voices")["voices"] if v["id"] == "Ryan")
    reports = []
    for index, item in enumerate(inputs[:args.limit]):
        result = formatter.prepare(item["text"], item.get("math", []))
        if args.speech:
            for mode in ("original", "prepared"):
                value = result["original"] if mode == "original" else result["text"]
                clip = request("/speech", {"text": value, "voice": voice["id"], "language": "en", "referenceId": voice["referenceId"]})
                file = args.output / f"{index}-{mode}.wav"
                with wave.open(str(file), "wb") as wav:
                    wav.setparams((1, 2, clip["sampleRate"], 0, "NONE", "not compressed"))
                    wav.writeframes(base64.b64decode(clip["pcm"]))
                result[mode + "Audio"] = clip
        reports.append(result)
        # Do not print input passages or model completions to terminal logs.
        print(f"Prepared {index + 1}: {sum(d['accepted'] for d in result['decisions'])}/{len(result['decisions'])} math expressions accepted", flush=True)
        (args.output / "report.json").write_text(json.dumps({"model": MODEL, "revision": REVISION, "loadSeconds": loaded, "reports": reports}, ensure_ascii=False, indent=2))
    print(f"Results: {args.output / 'report.json'}", flush=True)


if __name__ == "__main__":
    main()
