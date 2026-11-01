# Pipeline latency investigation

Measured on November 1, 2026, with synthetic content and real local models on
an Apple M5 Max with 36 GiB RAM. No browser, extension update or source capture
was involved. The installed app was not changed by these experiments.

## Method

The headless Node worker calls the production content assembler, paragraph
planner and playable-source projection. Python runs the production formatter,
speech model, forced aligner and artifact validation. Fixtures include two HTML
paragraphs (219 and 231 characters) and a 356-character OCR reading window
assembled across a split word on two fake pages. Both produce two speech chunks.

The final comparison alternates before/after in one warm process, with two
repetitions per condition. Each generation run has empty speech, alignment and
formatter-result caches. Voice, model revisions, sampling settings and seed are
fixed. Weights are already installed. Times include Node worker round trips,
but exclude browser, HTTP and Native Messaging transport.

Versions: MLX 0.32.4, MLX-LM 0.32.2, MLX-Audio 0.6.3. Raw reports under
`test-results/latency/` retain token counts, stage/queue timings, process-family
CPU time, sampled peak family RSS, MLX peak allocation and audio digests.

## More simultaneous chunks did not improve GPU throughput

With the original FIFO GPU owner, two in-flight HTML chunks took about the same
total time as one, but delayed the first playable paragraph from 5.93 to 11.94
seconds. OCR showed the same queueing problem: alignment waited behind another
paragraph's full speech generation.

In the final warm runs, the formatter's first text token arrived in 0.05–0.14
seconds; the speech model's first internal PCM packet arrived in 0.31–0.48 seconds.
These are not playable paragraphs yet. The player waits for complete paragraph
audio and measured alignment. Fresh speech generation dominates the time.

## Alignment prefetch is the backend default in 0.8.1

Prefetch completes alignment immediately after creating new audio,
before another speech job takes the GPU. The extension still makes its normal,
independent alignment request, which now hits the native cache. Artifact and
transport contracts stay unchanged.

Means of two warm paired runs with two chunks in flight:

| Fixture | First playable, baseline | First playable, prefetch | Total, baseline | Total, prefetch |
| --- | ---: | ---: | ---: | ---: |
| HTML | 10.75 s | 6.00 s | 10.86 s | 11.57 s |
| OCR | 9.10 s | 5.72 s | 9.19 s | 9.57 s |

First-playable latency improved 44% and 37%. Total completion was 7% and 4% slower
in this small sample. HTML prefetch startup ranged from 5.34 to 6.66 seconds;
this is not a broad hardware benchmark. All before/after PCM digests matched
exactly, including every generated sample.

Process-family CPU time was 14.69 → 15.11 seconds for HTML and 12.23 → 12.74 seconds
for OCR. Sampled family RSS was about 3.26 GB and MLX peak allocation about 5.86 GB,
with little difference between conditions. These are different views of shared
memory and must not be added together. Core model loading took 1.93 seconds
separately; the first process-run pipeline took 7.10 seconds to first playable.
This was not a clean-machine or cold-disk test.

Version 0.8.1 enables prefetch by default to favor earlier playback. Steady
generation speed still matters at 3×; standalone engines can opt out with
`--no-prefetch-alignment`. Raw model token speed is unchanged. A prefetch failure preserves valid
audio; the explicit alignment stage owns its error. Cancellation prevents late
results while preserving reusable audio artifacts.

## Other experiments

- **GPU batching:** two-text speech batches averaged 10.67 seconds and 32–34 codec
  frames/second without a convincing throughput gain. MLX peak allocation rose
  from roughly 5.85 to 7.01 GB. Batching was not enabled in the server.
- **Alignment between PCM packets:** this shortened queue waits, but the paired
  HTML total increased from 9.85 to 13.02 seconds. The prototype is retained only
  in the benchmark, outside the shipped runtime.
- **Larger decoder packets:** 1/2/4-second packets had overlapping timing ranges.
  Codec frames matched, but PCM digests changed with packet size. Production
  keeps its one-second decoder interval.
- **CPU alignment:** an exploratory CPU run was stopped after 79.8 seconds with
  no first playable chunk, using 81.3 CPU seconds. It was not retried or integrated.

The final paired runs produced 29–42 codec frames/second. The measured audio uses
12.5 frames per audio second, so uninterrupted 3× playback needs 37.5 frames/second.
Faster startup alone therefore cannot guarantee an uninterrupted 3× reading.

## Further opportunities

1. **Incremental playback and alignment** could use early PCM instead of waiting
   for a whole paragraph. It needs an append/commit protocol and an extension
   change; word timings must remain measured and stable.
2. **An edit-only formatter response** could reduce re-emission of long OCR
   windows while still inspecting all content. A quality corpus and source-map
   validation are needed before changing the recipe.
3. **Persistent formatting results** could avoid repeated LLM work after restarts.
   Speech/alignment already persist; formatter results currently live in memory.
   This helps repeated content, not fresh speech tokens.

## Reproduce

Use the existing Python environment, Node toolchain and prepared app models:

```sh
# One versus two in-flight chunks; optional speech batching trial.
PATH="/usr/local/bin:$PATH" .venv/bin/python scripts/benchmark-pipeline.py --batch

# Alternating alignment-prefetch comparison in the same warm process.
PATH="/usr/local/bin:$PATH" .venv/bin/python scripts/benchmark-pipeline.py \
  --compare-prefetch --output test-results/latency/paired-prefetch.json

# Isolated decoder and cooperative-scheduling experiments.
PATH="/usr/local/bin:$PATH" .venv/bin/python scripts/benchmark-pipeline.py \
  --decode-only --decode-intervals 1 2 4
PATH="/usr/local/bin:$PATH" .venv/bin/python scripts/benchmark-pipeline.py \
  --compare-checkpoints
```

References are copied into a temporary directory and stage caches are disposable.
The harness does not change the installed app, browser preferences, models or
production audio cache. Stop other speech work before measuring; the harness
does not stop an arbitrary active engine. Repetitions are bounded to 1–3.

The backend enables prefetch by default, including the app's normal startup.
`local/server.py --prefetch-alignment` explicitly enables it and
`--no-prefetch-alignment` disables it. An updated/restarted backend is needed,
**no extension reload** for this scheduling change. A gateway leaves scheduling
to its upstream engine and reports that engine's setting in `/health`; a missing
upstream field remains unknown. Existing independent endpoints are not restarted
or reconfigured by the app.

The original investigation passed 76 JavaScript and 47 Python tests, including
HTTP artifact contracts, cache warming, queued speech ownership, cancellation and
alignment failure. The 0.8.1 default change passed 76 JavaScript, 49 Python and
48 native checks. Its installed native host started the packaged engine without
an enabling flag, produced fresh real-model speech and hit the alignment cache
on the first explicit alignment call. A real gateway forwarded speech and
reported the upstream setting. Browser/Kindle behavior was outside this headless
investigation; prior installed 0.8.0 playback evidence is recorded separately.
