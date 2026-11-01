# Whole-passage speech preparation

Starting with 0.7.0, every newly generated local speech passage goes through
Qwen3 1.7B at 4-bit precision before Qwen3-TTS and its forced aligner. It does
not select passages by a list of known formatting problems. Clean text,
unfamiliar formatting and ordinary prose all use the same prompt. An in-memory
cache reuses preparation for an identical passage; cached audio skips synthesis
and preparation entirely.

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
