# Whole-passage speech preparation

Starting with 0.7.0, every newly generated local speech passage goes through
Qwen3 1.7B at 4-bit precision before Qwen3-TTS and its forced aligner. It does
not select passages by a list of known formatting problems. Clean text,
unfamiliar formatting and ordinary prose all use the same prompt. An in-memory
cache reuses preparation for an identical passage; cached audio skips synthesis
and preparation entirely.

Starting with 0.7.1, OCR preparation happens before speech chunking. It receives
the full visible page plus an available continuation for an unfinished tail.
Recognized line breaks remain available to the model, so it can join wrapped
words. Later pages consume that joined prefix once. Narration already committed
to audio is not rewritten. See [the continuous reading queue](source-adapters.md#shared-queue).

Starting with 0.7.2, each source paragraph is one speech request. HTML no longer
has a second 160-character splitter. OCR prepares the full window first, then
projects the original paragraph boundaries through the LLM's UTF-16 mapping.
Visual line wraps and LLM-inserted blank lines cannot create extra speech
requests. An unfinished page tail includes the next page's entire first
paragraph, including subsequent sentences, before synthesis. Original OCR
fragments remain available for highlighting and word seeking.

The first full paragraph must finish synthesis and alignment before playback.
Later paragraphs are prepared ahead. Requests accept up to 12,000 UTF-16 units;
a separate 4,096-codec-token audio limit rejects an unfinished generation before
any audio is returned. Paragraphs are never silently cut to fit either limit.
OCR paragraph grouping and continuation detection still depend on page layout
and recognized punctuation; this is not perfect paragraph reconstruction for
every book.

## Pipeline

1. The source adapter extracts text and retains its original page coordinates.
2. The complete requested passage is sent to the local LLM. No math annotations,
   classifiers or predefined expression grammar choose what reaches the model.
3. After inference, content checks accept the result or retain the original.
4. Qwen3-TTS speaks the accepted text. The forced aligner receives that same text
   and the actual generated audio.
5. The reader maps measured words back onto the original source for highlights
   and word clicks. The comparison preview also retains an explicit UTF-16 map.

The prompt requests minimal formatting repair while preserving words, names,
identifiers, numbers, negations, order and language. Content checks compare the
ordered letters/numbers after compatibility normalization, numeric literals,
semantic operators and protected literals. This permits spacing, line-wrapping
and presentation changes without accepting paraphrases or dropped identifiers.
A rejected or incomplete response uses the original passage. Cancellation stops
preparation before a result can be published or cached.

These checks do not prove semantic equivalence: punctuation and word boundaries can affect meaning,
and the model may leave a formatting issue unchanged. This is formatting repair,
not summarization or arbitrary notation expansion. Some inputs still use their
original text. The earlier math-only route and its expression grammar have been
removed.

## Installation and cache identity

The Mac app brings MLX-LM alongside its existing Python inference runtime.
Its model installer downloads and verifies the formatter using the same pinned,
resumable manifest as the narrator and aligner. The formatter adds approximately
984 MB; current source builds prepare about 4.60 GB of model files in total.
The older linked 0.5.1 binary predates this feature.

Model, revision, prompt, decoding settings and policy determine a preparation
identity embedded in the speech pipeline ID. Changing that recipe invalidates
old audio cache keys. Reference voices and playback speed are unchanged. Source
text and model responses remain local; model setup only downloads public files.
The formatter holds at most 128 prepared passages in memory and exits with the
app-managed voice engine.

The `/prepare` operation accepts a reading window of up to 12,000 UTF-16 code
units. It returns accepted text and its original-source projection. Speech pieces
carry an identity and exact prepared-text range; the runtime verifies the slice
and skips repeated inference. The original window also permits cache restoration
after the idle engine exits. An incompatible restoration requires reopening,
rather than silently narrating different prepared text. Ordinary HTML speech
requests continue to use their full requested passage.

## Compare original and prepared speech

With the current local engine running:

```sh
.venv/bin/python scripts/try-text-cleanup.py tests/cleanup-input.json --speech
npm run dev
```

Open `http://127.0.0.1:4317/tests/cleanup.html`. The comparison script uses the
installed engine's configured loopback port. `--port` selects another compatible
local engine; omit `--speech` to inspect only LLM formatting. Input is an array
of objects containing `text` and an optional `language`, without marked spans.

The diagnostic HTTP option `prepare: false` generates the original comparison
clip. Normal Chrome requests do not expose or send that override: preparation
is on by default. The prepared clip carries the original, candidate, accepted
text, status, reason and formatter identity. The script refuses a speech service
that did not use the current preparation recipe.

Reports and audio are written to the gitignored `.cache/text-cleanup/`. They
contain source text; keep private inputs local. The loopback development server
serves that local preview. These developer artifacts are not packaged in the app.

## Verification scope

The installed 0.7.0 app and reloaded Chrome extension were exercised on the
included `tests/whole-passage.html` article. Playback generated all seven pieces,
highlighted original HTML words, continued into later paragraphs, and supported
forward/backward word clicks, pause, Follow words and Stop. The production native
host separately returned actual Qwen audio, preparation metadata and measured
word timings for a passage whose sentence spacing was repaired.

The browser comparison checks
shifted source highlights, clicking original words to seek prepared audio,
pitch-preserving 3x playback, following word coordinates and Stop cleanup.
Its six passages include formatting repairs, unchanged clean text, unfamiliar
formatting and a rejected response to an instruction inside the source passage.

The broader model trial also covered line-wrapped words, invisible characters,
bullets, signed decimals, identifiers and Chinese text. The 0.6B trial changed
content too often; 1.7B plus post-inference checks was used for integration.
Quality remains limited on some inputs: Chinese formatting and some wrapped
words were not reliably repaired, while rejected responses kept the original.

Python boundary checks cover inference for every unmarked passage, content and
literal changes, caching, cancellation and incomplete output. JavaScript checks
cover UTF-16 mapping, insertions/deletions, source coverage and word alignment.
Clean-machine installation and every website/language remain unverified.

The continuous OCR browser fixture passed with actual Apple Vision, Qwen3 LLM,
Qwen3-TTS and forced alignment. It repaired `re-` / `markable` across two page
images, presented the next page at the measured word, then skipped the consumed
prefix. On the test Mac, one run started in 4.17 seconds; its speech pieces took
0.92–1.59 seconds for synthesis and 0.05–0.07 seconds for alignment. A separate
987-character window took 0.86 seconds to prepare. These are warm-engine samples,
not a controlled before/after benchmark or a guarantee at 3x. Physical navigation
and cold model loading add latency. Live Amazon Kindle was not rerun for this
change.

The installed 0.7.1 native host also passed full-window preparation followed by
verified prepared-piece speech, returning measured words and framed audio. Its
first speech request took 5.51 seconds, then 2.61 seconds for a warm repeat of the
same prepared text (fresh synthesis, not audio-cache replay). This illustrates
the remaining cold-start cost; the LLM is not the dominant stage in that sample.

The 0.7.2 HTML browser regression used real Qwen synthesis and forced alignment:
a 591-character, multi-sentence paragraph remained one request. Playback crossed
“plunging stock” in the same audio clip without an `ended` event, clip replacement
or buffering transition, with original-page highlighting and measured word
seeking. It produced 31.9 seconds of audio with 9.25 seconds of synthesis and
0.23 seconds of alignment in one warm-engine sample. This verifies removal of
the artificial request boundary; it does not assert that the model adds no
natural pauses. The updated real-Vision OCR fixture also kept a two-sentence
cross-page paragraph in one request and consumed it once. Live Amazon Kindle
and the user's original news article were not rerun for 0.7.2.

The installed 0.7.2 native host independently generated the same full HTML
paragraph through the last word, returning 13 framed audio chunks and measured
timestamps. That request took 9.14 seconds, including 1.07 seconds of formatting,
7.71 seconds of speech generation and 0.15 seconds of alignment. The app and
bundled extension were installed and code-signature verification passed; Chrome
still requires the user's Reload to activate the installed extension update.
