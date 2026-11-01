# Reading continuity investigation

Unreleased source changes, tested November 1, 2026. Chrome and the installed
extension were not opened, reloaded or updated for this investigation.

## Reproduction and causes

The supplied two-column screenshot was cropped to its book text and processed
with the installed Apple Vision OCR executable. The production 0.8.1 OCR parser
produced two blocks of 658 and 670 characters. One ended with `creaks`; the next
started with `with the sound of metal on metal.` Speech therefore restarted in
the middle of a sentence.

The parser compared horizontal indentation with a vertically normalized glyph
height. Those units differ on a wide image, hiding actual paragraph indents.
It also always began a new block for the next column. The fix uses image
dimensions for the indentation comparison and joins an unfinished sentence into
an unindented column continuation, preserving the original word boxes.

The local LLM rejected its attempted reformatting because it omitted words.
Keeping the original content was correct, but that fallback left visual line
breaks in the TTS input. The speech preparation step now removes soft wraps
inside the known paragraph ranges after the optional LLM. This also runs when
formatting is disabled. It preserves paragraph boundaries, non-whitespace
characters, hyphens and exact source projection.

Page presentation had two additional blocking paths: a continuation explicitly
paused its playing audio until navigation finished, and a ready next-page clip
waited for navigation before starting. Presentation now runs independently;
word markers catch up to the current measured word when the image is ready.
User Pause and Stop still take effect during navigation. Physical page traversal
and restoration remain serialized by the source adapter.

Concurrent preparation could also find an entire future page already consumed
as the current paragraph's continuation. That page has no remaining speech;
it now skips model preparation instead of creating an invalid empty artifact.
A regression reproduced the original error before this change.

## Local evidence

The actual screenshot now produces ten paragraphs. The complete target
paragraph is one 193-character speech request, including both sides of the
column boundary. The replay used the production formatter, Qwen speech model,
forced aligner and source projection through the local engine on port 4324.

| Observed on this screenshot with Ryan | Published 0.8.1 | Working source |
| --- | ---: | ---: |
| OCR paragraphs | 2 | 10 |
| Requests covering the target sentence | 2 | 1 |
| Aligned gap from `creaks` to `with`, at normal speed | 720 ms | 0 ms |

These are one generated before/after example, not a statistical performance or
subjective listening study. Forced-aligner timestamps have finite resolution;
zero aligned gap does not establish sample-perfect continuity. Subsequent
replays reused the same cached PCM. No raw model-token speed improvement is
claimed.

A separate Audio fixture used the real word timings and held page presentation
pending for an injected 250 ms. The old session called Pause and advanced no
audio; the fixed session called no Pause and advanced 750 ms of source audio at
3x. This is a controlled application test, not browser playback or a measured
Kindle navigation duration.

The JavaScript suite passed 81 tests, covering geometry/word hits, optional or
rejected formatting, UTF-16 source offsets, continuations, consumed pages,
slow presentation, ready next-page audio and Pause/Stop. The extension build
also passed. No installed-extension or live Kindle playback was performed for
these source changes.

## Replay without Chrome

Start the existing local engine, then use the built-in synthetic OCR layout:

```sh
PATH="/usr/local/bin:$PATH" node scripts/check-reading-continuity.mjs
```

For actual Vision JSON and a comparison with the published 0.8.1 source:

```sh
PATH="/usr/local/bin:$PATH" node scripts/check-reading-continuity.mjs \
  --ocr test-results/kindle-continuity/vision.json --baseline 0860906 \
  --output test-results/kindle-continuity/replay
```

The JSON must contain the reported words. The selected baseline revision must
exist in the local checkout. `--port` selects another loopback engine;
`--bypass-formatter` verifies the path with no LLM calls. Reports preserve speech,
audio, alignment and source artifacts; before/after boundary WAVs are written
alongside them. Screenshot text and generated audio remain in ignored local
`test-results/` files and are not published with source.

Playback still uses completed paragraph WAVs. These fixes remove the reproduced
layout split and navigation-induced pause; they do not implement an incremental
PCM playback protocol or guarantee that fresh generation keeps up with 3x.
