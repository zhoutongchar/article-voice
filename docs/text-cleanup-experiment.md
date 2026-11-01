# Local HTML speech preparation experiment

This is an opt-in development experiment, not a new default in the installed
Chrome extension. It uses Qwen3 0.6B at 4-bit precision (about 335 MB of weights,
351 MB for the downloaded snapshot) in an isolated Python environment. It does
not replace or restart the existing voice engine. No article text goes to a
cloud model.

## What the actual HTML showed

The current DOM text mapper preserves ordinary whitespace, but loses math
structure: a rendered subscript such as `sₜ` becomes `st`, and `aₜ` becomes `at`.
HTML still provides the original LaTeX annotation. Reading that annotation
alongside its original source span is more reliable than guessing from flat text.

A first trial asking the 0.6B model to clean six real, flattened HTML paragraphs
deleted identifiers from three of them. That approach is not enabled. The
constrained experiment copies prose exactly and asks the model to verbalize
explicit math expressions. A small grammar verifies supported identifiers,
subscripts, exponents, equality, digits and operators. Model answers that change
the expression are declined; unsupported expressions keep their original text.
This is not a general math reader, prose editor or OCR correction engine.

## Pipeline and source positions

1. Supply extracted HTML text and its explicitly identified math spans, with
   their LaTeX annotations. Offsets are UTF-16, matching the browser.
2. The local formatter prepares speech text and a mapping from prepared spans
   to the original source spans. Prose is preserved character for character.
3. The existing local Qwen voice engine generates that prepared text and runs
   its forced aligner against the same prepared text and actual audio.
4. The browser projects aligned words through the source mapping. For example,
   all words in “s subscript t” highlight the original `sₜ`. Source word clicks
   use the reverse mapping to seek to the prepared audio.

The aligner cannot restore identifiers that an LLM deleted or verify the truth
of rewritten content. Validation and source mapping happen before synthesis.
The generic installed HTML extractor does not yet provide this experiment's
structured math input automatically; captured samples and the public fixture
provide it explicitly. Full Chrome integration requires that extraction boundary
and the formatter's installation/lifecycle to be connected, with broader tests.

## Try it locally

From the repository root, create the separate formatter environment:

```sh
uv venv --python .venv/bin/python .cache/cleanup-venv
uv pip install --python .cache/cleanup-venv/bin/python -r local/cleanup-requirements-lock.txt
.cache/cleanup-venv/bin/python scripts/try-text-cleanup.py tests/cleanup-input.json --speech
npm run dev
```

Open `http://127.0.0.1:4317/tests/cleanup.html`. The installed Article Voice
engine must already be ready; the script uses its configured loopback port, or
`--port` can select an existing standalone engine. The model revision is pinned
in `local/text_cleanup.py` and downloaded once. No remote model code is loaded.

The preview has original/prepared audio, a passage selector, clickable original
HTML, word highlighting, pause/stop and 1–3× speed. **Run browser checks** uses
the production reader engine and actual generated audio and measured alignments.
It verifies playback, source expression marks, clicking an expression to seek,
3× pitch-preserving playback, subsequent prose coordinates and Stop cleanup.

For another sample, pass a JSON array with `text` and `math` members as in
`tests/cleanup-input.json`. The script writes original text and audio to the
gitignored `.cache/text-cleanup/`; keep private inputs local. The development
server's loopback-only preview serves this directory to that browser.

## Measured trial

On the test Mac, three real HTML paragraphs produced six real Qwen clips:
original and prepared versions. All four marked expressions were accepted with
prose preserved. Formatter loading took about 1.1 seconds. The separate
nine-expression trial measured about 0.02–0.07 seconds per expression after loading.
These are warm local measurements for very short math expressions, not a
benchmark of arbitrary prose or equations. Cached expressions reuse their result.

The nine-expression standalone model trial covered simple variables, subscripts,
`t+1`, equality and a square. Complex equations, other languages, general prose
repair, clean-machine packaging and installed-extension integration remain
unverified. The Python and JavaScript boundary tests exercise UTF-16 positions,
mapping completeness, unsupported expressions and content-preservation failures.
