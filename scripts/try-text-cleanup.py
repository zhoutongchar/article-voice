"""Compare whole-passage LLM preparation with original speech and alignment.

Input is an array of {"text": "a complete extracted passage", "language": "en"}.
No annotations, math ranges or formatting classification are required.
"""
import argparse
import base64
import json
import sys
import wave
from pathlib import Path
from urllib.request import ProxyHandler, Request, build_opener

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'local'))
from text_cleanup import MODEL, REVISION, TextFormatter


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('input', type=Path)
    parser.add_argument('--output', type=Path, default=ROOT / '.cache/text-cleanup')
    parser.add_argument('--speech', action='store_true')
    parser.add_argument('--port', type=int, default=json.loads((ROOT / 'chrome/connection.json').read_text())['port'])
    parser.add_argument('--limit', type=int, default=6)
    args = parser.parse_args()
    inputs = json.loads(args.input.read_text())
    if not isinstance(inputs, list) or not 1 <= args.limit <= 20 or not 1 <= args.port <= 65535:
        parser.error('Expected an array of passages, a limit from 1 to 20 and a valid loopback port')
    args.output.mkdir(parents=True, exist_ok=True)
    http = build_opener(ProxyHandler({}))

    def request(path, data=None):
        req = Request(f'http://127.0.0.1:{args.port}' + path,
                      data=json.dumps(data).encode() if data is not None else None,
                      headers={'Content-Type': 'application/json'} if data is not None else {})
        with http.open(req, timeout=180) as response: return json.load(response)

    f = voice = None
    if args.speech:
        if not request('/health').get('ready'): raise RuntimeError('Start the local voice engine first')
        voice = next(v for v in request('/voices')['voices'] if v['id'] == 'Ryan')
    else:
        from huggingface_hub import snapshot_download
        path = snapshot_download(MODEL, revision=REVISION,
                                 allow_patterns=['*.json', '*.safetensors', '*.jinja', '*.txt', 'README.md', 'LICENSE'])
        f = TextFormatter(path)
    reports = []
    for i, item in enumerate(inputs[:args.limit]):
        text = item['text']
        if args.speech:
            clips = {}
            for mode in ('original', 'prepared'):
                clips[mode] = request('/speech', {'text': text, 'voice': voice['id'], 'language': item.get('language', ''),
                                                  'referenceId': voice['referenceId'], 'prepare': mode == 'prepared'})
                with wave.open(str(args.output / f'{i}-{mode}.wav'), 'wb') as wav:
                    wav.setparams((1, 2, clips[mode]['sampleRate'], 0, 'NONE', 'not compressed'))
                    wav.writeframes(base64.b64decode(clips[mode]['pcm']))
            result = clips['prepared'].get('preparation')
            if not result or result['identity'] != __import__('text_cleanup').preparation_identity():
                raise RuntimeError('Update the voice engine: whole-passage preparation was not used')
            result = {**result, 'originalAudio': clips['original'], 'preparedAudio': clips['prepared']}
        else:
            result = f.prepare(text)
        reports.append(result)
        print(f'Passage {i + 1}: {result["status"]} ({result["elapsed"]:.3f}s)', flush=True)
        (args.output / 'report.json').write_text(json.dumps({'model': MODEL, 'revision': REVISION, 'reports': reports}, ensure_ascii=False, indent=2))
    print(f'Results: {args.output / "report.json"}', flush=True)


if __name__ == '__main__': main()
