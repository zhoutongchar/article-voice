"""Real-model latency experiment from synthetic assembled ContentChunks.

No browser, extension change, network model download or production cache mutation.
One GPU owner is retained. Batch inference is an experiment, not a server change.
"""
import argparse
import concurrent.futures
import contextlib
import json
import platform
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from importlib.metadata import version

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'local'))
from runtime import SpeechRuntime, CONFIG, MAX_SPEECH_TOKENS
from stage_executor import StageExecutor
from artifact_store import ArtifactStore
from latency_experiments import CheckpointExecutor


class Planner:
    def __init__(self):
        self.lock = threading.Lock()
        self.process = subprocess.Popen(['node', str(ROOT / 'scripts/pipeline-fixture-worker.mjs')],
                                        stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, cwd=ROOT)

    def call(self, method, **values):
        with self.lock:
            self.process.stdin.write(json.dumps({'method': method, **values}) + '\n'); self.process.stdin.flush()
            result = json.loads(self.process.stdout.readline())
            if 'error' in result: raise ValueError(result['error'])
            return result['result']

    def close(self):
        self.process.stdin.close()
        try: self.process.wait(timeout=5)
        except subprocess.TimeoutExpired: self.process.terminate(); self.process.wait(timeout=5)


class ProfileRuntime(SpeechRuntime):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.events = []; self.context = threading.local(); self.started = time.perf_counter()

    def gpu(self, operation, cancelled=None, priority=0):
        enqueued = time.perf_counter(); label = getattr(self.context, 'stage', None) or 'load'
        def measured():
            start = time.perf_counter()
            try: return operation()
            finally: self.events.append({'stage': label, 'queued': enqueued - self.started,
                                         'start': start - self.started, 'end': time.perf_counter() - self.started,
                                         'wait': start - enqueued})
        if not isinstance(self.executor, CheckpointExecutor): return super().gpu(measured, cancelled, priority)
        def run():
            if cancelled and cancelled.is_set(): raise InterruptedError('Reading cancelled')
            with self.model_lock: return measured()
        if threading.current_thread() is self.executor.thread: return run()
        future = self.executor.submit(run, priority=priority, stage=label)
        while True:
            try: return future.result(timeout=.1)
            except concurrent.futures.TimeoutError:
                if cancelled and cancelled.is_set(): future.cancel(); raise InterruptedError('Reading cancelled')

    def align(self, *args, **kwargs):
        return self.call_stage('align', lambda: super(ProfileRuntime, self).align(*args, **kwargs))

    def call_stage(self, stage, fn):
        previous = getattr(self.context, 'stage', None)
        self.context.stage = stage
        try: return fn()
        finally: self.context.stage = previous


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--models', type=Path, default=Path.home() / 'Library/Application Support/Article Voice/Models')
    parser.add_argument('--references', type=Path, default=Path.home() / 'Library/Application Support/Article Voice/voice-references')
    parser.add_argument('--output', type=Path, default=ROOT / 'test-results/latency/report.json')
    parser.add_argument('--repeats', type=int, default=2)
    parser.add_argument('--batch', action='store_true')
    parser.add_argument('--alignment-checkpoints', action='store_true', help='Experiment: service alignment between PCM packets')
    parser.add_argument('--compare-checkpoints', action='store_true', help='Alternate before/after in one warm process')
    parser.add_argument('--prefetch-alignment', action='store_true', help='Warm alignment immediately after each new speech result')
    parser.add_argument('--compare-prefetch', action='store_true', help='Alternate alignment prefetch before/after in one warm process')
    parser.add_argument('--cases', nargs='+', choices=['html', 'ocr'], default=['html', 'ocr'])
    parser.add_argument('--concurrency', nargs='+', type=int, choices=[1, 2], default=[1, 2])
    parser.add_argument('--decode-only', action='store_true')
    parser.add_argument('--decode-intervals', type=float, nargs='+', choices=[1., 2., 4.], default=[])
    args = parser.parse_args()
    if not 1 <= args.repeats <= 3: parser.error('Use 1–3 bounded repetitions')
    if args.batch and args.decode_only: parser.error('Batch comparison requires scheduling runs')
    if args.compare_checkpoints and (args.decode_only or args.batch or args.prefetch_alignment): parser.error('Run the paired checkpoint comparison separately')
    if args.compare_prefetch and (args.alignment_checkpoints or args.compare_checkpoints or args.decode_only or args.batch or args.prefetch_alignment): parser.error('Run the paired prefetch comparison separately')
    for folder in ('narrator', 'aligner', 'formatter'):
        if not (args.models / folder / 'config.json').is_file(): parser.error(f'Missing installed {folder} model')
    import mlx.core as mx
    import mlx_lm
    import numpy as np
    import psutil
    planner = Planner(); checkpoints_enabled = args.alignment_checkpoints
    executor = CheckpointExecutor(alignment_checkpoints=checkpoints_enabled) if args.alignment_checkpoints or args.compare_checkpoints else StageExecutor()
    stop = threading.Event(); peak = [0, 0]
    process = psutil.Process()
    def sample_memory():
        while not stop.wait(.1):
            family = [process, *process.children(recursive=True)]
            total = 0
            for child in family:
                with contextlib.suppress(psutil.Error): total += child.memory_info().rss
            peak[0] = max(peak[0], total); peak[1] = max(peak[1], total)
    def family_cpu():
        total = 0
        for child in [process, *process.children(recursive=True)]:
            with contextlib.suppress(psutil.Error):
                times = child.cpu_times(); total += times.user + times.system
        return total
    sampler = threading.Thread(target=sample_memory, daemon=True); sampler.start()
    report = {'schemaVersion': 1, 'synthetic': True, 'alignmentCheckpoints': checkpoints_enabled, 'model': CONFIG['model'], 'revision': CONFIG['revision'],
              'machine': {'architecture': platform.machine(), 'os': platform.mac_ver()[0], 'memoryBytes': psutil.virtual_memory().total,
                          'chip': subprocess.check_output(['sysctl', '-n', 'machdep.cpu.brand_string'], text=True).strip()},
              'packages': {name: version(name) for name in ('mlx', 'mlx-lm', 'mlx-audio', 'psutil')},
              'aligner': CONFIG['aligner'], 'alignerRevision': CONFIG['alignerRevision'],
              'generation': CONFIG['generation'], 'runs': [], 'batch': [], 'notes': [
                  'Speech/alignment caches and formatter result cache are empty for each generation run.',
                  'GPU calls are serialized; concurrency means independent chunks in flight, not concurrent GPU threads.',
                  'TTS first-packet latency measures the existing one-second PCM packet, not a raw codec token.',
                  'Node assembler/planner/projection use production modules through a persistent headless worker.']}
    real_stream = mlx_lm.stream_generate
    try:
        assembly_start = time.perf_counter(); fixtures = planner.call('fixtures')
        report['assemblerStartupSeconds'] = time.perf_counter() - assembly_start
        with tempfile.TemporaryDirectory(prefix='article-voice-latency-') as directory:
            shutil.copytree(args.references, Path(directory) / 'voice-references')
            runtime = ProfileRuntime(directory, args.models, executor=executor)
            def missing_reference(_): raise ValueError('This benchmark needs the nine prepared app voices; it never downloads a reference model')
            for voice in CONFIG['voices']: runtime.references.load(voice['id'], missing_reference)
            token_events = []
            def text_stream(*values, **options):
                start = time.perf_counter(); first = None; last = None
                for part in real_stream(*values, **options):
                    if first is None: first = time.perf_counter() - start
                    last = part; yield part
                if last is not None: token_events.append({'stage': 'format', 'ttft': first,
                    'promptTokens': last.prompt_tokens, 'generationTokens': last.generation_tokens,
                    'promptTps': last.prompt_tps, 'generationTps': last.generation_tps})
            mlx_lm.stream_generate = text_stream  # Instrument only this benchmark process.
            load_start = time.perf_counter(); runtime.load(); report['loadSeconds'] = time.perf_counter() - load_start
            report['voice'] = {'id': 'Ryan', 'referenceId': runtime.reference_identity('Ryan')}
            original_generate = runtime.tts.generate; decoder_interval = None
            def generated(*values, **options):
                # Seed on the GPU-owning thread, not the coordinator thread.
                mx.random.seed(1729)
                if decoder_interval is not None: options['streaming_interval'] = decoder_interval
                start = time.perf_counter(); first = None; tokens = 0
                for part in original_generate(*values, **options):
                    if first is None: first = time.perf_counter() - start
                    tokens += part.token_count; yield part
                    if isinstance(executor, CheckpointExecutor): executor.yield_alignment()
                elapsed = time.perf_counter() - start
                token_events.append({'stage': 'synthesize', 'firstPcmPacket': first, 'codecFrames': tokens,
                                     'elapsed': elapsed, 'codecFramesPerSecond': tokens / elapsed})
            runtime.tts.generate = generated
            report['fixtureCharacters'] = {name: [len(c['text']) for c in chunks] for name, chunks in fixtures.items()}
            formatted_for_batch = []
            def run(name, concurrency, label):
                runtime.store = ArtifactStore(Path(directory) / f'run-{len(report["runs"])}')
                if runtime.formatter is not None: runtime.formatter.cache.clear()
                runtime.events.clear(); token_events.clear(); mx.reset_peak_memory(); mx.random.seed(1729); peak[0] = 0
                runtime.started = start = time.perf_counter(); cpu = family_cpu()
                assembly_start = time.perf_counter(); chunks = planner.call('fixtures')[name]
                assembly_seconds = time.perf_counter() - assembly_start
                ready = []
                def process_content(chunk):
                    prepared = runtime.call_stage('format', lambda: runtime.format_content(chunk))
                    assert not prepared.get('cached')
                    spoken = planner.call('plan', content=prepared['output'])
                    def process_speech(part):
                        sound = runtime.call_stage('synthesize', lambda: runtime.synthesize(part, 'Ryan', 'en', prefetch_alignment=args.prefetch_alignment))
                        assert not sound['cached']
                        measured = runtime.call_stage('align', lambda: runtime.align(part, sound['output'], 'en'))
                        assert measured['cached'] == args.prefetch_alignment
                        playable = planner.call('project', content=prepared['output'], speech=part, audio=sound['output'], alignment=measured['output'])
                        assert playable['words'] and any(word['sources'] for word in playable['words'])
                        ready.append({'sequence': [chunk['sequence'], part['sequence']], 'at': time.perf_counter() - start,
                                      'audioSeconds': sound['output']['frames'] / 24000, 'words': len(playable['words']),
                                      'text': part['text'], 'formatStatus': prepared['status'], 'pcmDigest': sound['output']['pcmDigest']})
                        return part
                    if name == 'ocr' and concurrency > 1:
                        with concurrent.futures.ThreadPoolExecutor(max_workers=concurrency) as pool: return list(pool.map(process_speech, spoken))
                    return [process_speech(part) for part in spoken]
                with concurrent.futures.ThreadPoolExecutor(max_workers=concurrency) as pool:
                    planned = list(pool.map(process_content, chunks))
                result = {'case': name, 'label': label, 'concurrency': concurrency, 'wall': time.perf_counter() - start,
                          'alignmentCheckpoints': checkpoints_enabled,
                          'prefetchAlignment': args.prefetch_alignment,
                          'cpu': family_cpu() - cpu,
                          'assemblySeconds': assembly_seconds,
                          'firstPlayable': next(item['at'] for item in ready if item['sequence'] == [0, 0]),
                          'ready': sorted(ready, key=lambda x: x['sequence']), 'gpuEvents': list(runtime.events),
                          'tokens': list(token_events), 'gpuPeakBytes': mx.get_peak_memory(), 'familyPeakRssBytes': peak[0]}
                report['runs'].append(result)
                print(json.dumps({k: result[k] for k in ('case','label','concurrency','wall','firstPlayable')}), flush=True)
                args.output.parent.mkdir(parents=True, exist_ok=True); args.output.write_text(json.dumps(report, indent=2))
                return [part for parts in planned for part in parts]
            run('html', 1, 'cold')
            if args.compare_prefetch:
                for repeat in range(args.repeats):
                    for case in args.cases:
                        for enabled in ((False, True) if repeat % 2 == 0 else (True, False)):
                            args.prefetch_alignment = enabled
                            run(case, 2, f'prefetch-{"on" if enabled else "off"}-{repeat + 1}')
            elif args.compare_checkpoints:
                for repeat in range(args.repeats):
                    for case in args.cases:
                        for enabled in ((False, True) if repeat % 2 == 0 else (True, False)):
                            checkpoints_enabled = enabled
                            executor.alignment_checkpoints = enabled
                            run(case, 2, f'paired-{"on" if enabled else "off"}-{repeat + 1}')
            elif not args.decode_only:
                for repeat in range(args.repeats):
                    for case in args.cases:
                        for concurrency in args.concurrency if repeat % 2 == 0 else reversed(args.concurrency):
                            parts = run(case, concurrency, f'warm-{repeat + 1}')
                            if case == 'html': formatted_for_batch = parts
            for repeat in range(args.repeats):
                for interval in args.decode_intervals if repeat % 2 == 0 else reversed(args.decode_intervals):
                    decoder_interval = interval
                    run('html', 1, f'decoder-{interval:g}s-{repeat + 1}')
            decoder_interval = None
            if args.batch:
                texts = [part['text'] for part in formatted_for_batch[:2]]
                ref = runtime.references.voices['Ryan']
                for repeat in range(args.repeats):
                    pieces = [[], []]; frame_counts = [0, 0]; first = None
                    mx.reset_peak_memory(); mx.random.seed(1729); peak[0] = 0; start = time.perf_counter(); cpu = family_cpu()
                    def infer_batch():
                        nonlocal first
                        mx.random.seed(1729)
                        for part in runtime.tts.batch_generate(texts=texts, ref_audio=runtime.reference_audio['Ryan'], ref_text=ref.transcript,
                                lang_code='English', **CONFIG['generation'], max_tokens=MAX_SPEECH_TOKENS, stream=True, streaming_interval=1., verbose=False):
                            if first is None: first = time.perf_counter() - start
                            pieces[part.sequence_idx].append(np.asarray(part.audio, dtype=np.float32).reshape(-1)); frame_counts[part.sequence_idx] += part.token_count
                    runtime.call_stage('batch', lambda: runtime.gpu(infer_batch))
                    elapsed = time.perf_counter() - start
                    assert all(0 < count < MAX_SPEECH_TOKENS for count in frame_counts)
                    sounds = [np.concatenate(parts) for parts in pieces]
                    assert all(len(sound) and np.isfinite(sound).all() for sound in sounds)
                    item = {'repeat': repeat, 'wall': elapsed, 'firstPcmPacket': first, 'cpu': family_cpu() - cpu,
                            'codecFrames': frame_counts, 'codecFramesPerSecond': sum(frame_counts) / elapsed,
                            'audioSeconds': [len(sound) / 24000 for sound in sounds], 'gpuPeakBytes': mx.get_peak_memory(),
                            'familyPeakRssBytes': peak[0]}
                    report['batch'].append(item); print(json.dumps({'batch': item}), flush=True)
            report['familyPeakRssBytes'] = peak[1]
            args.output.write_text(json.dumps(report, indent=2))
    finally:
        mlx_lm.stream_generate = real_stream
        stop.set(); sampler.join(); executor.shutdown(cancel_futures=True); planner.close()


if __name__ == '__main__': main()
