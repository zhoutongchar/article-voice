# Article Voice

Listen to Chrome articles with natural voices running on your Mac. Follow the spoken word on the original page, click any word to seek, and listen at **0.5×–3×** with pitch preserved.

**[Download the Mac preview](https://github.com/zhoutongchar/article-voice/releases/tag/v0.5.1)** · [Mac app architecture and build](macos/README.md)

The `main` source now includes extensible [reading source adapters](docs/source-adapters.md), a shared queue, and a Kindle adapter with local Apple Vision OCR and automatic page turns. The 0.8.0 source uses versioned [pipeline contracts](docs/pipeline.md), optional text formatting, independent speech/alignment caches and bounded stage scheduling. These changes are newer than the linked 0.5.1 binary preview. Current builds install 3.61 GB of core model files and download a further 0.99 GB on first enabled formatter use. YouTube transcript support is a future adapter.

![Article Voice's thin audio player](docs/images/minimal-player.png)

## Install the preview

Requires **Apple Silicon, macOS 26 or later, and Google Chrome**. This preview has been exercised on an M5 Max with 36 GB RAM; smaller Macs have not been verified.

1. Download **Article-Voice.zip** from the release, unzip it, and open **Article Voice.app**.
2. Click **Install Article Voice**. It installs into `~/Applications` and prepares the voices. The first setup downloads **3.61 GB** of model files, with progress, pause/resume, and checksum verification. Python and the speech runtime are included in the app.
3. Click **Connect Chrome**. In `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select the folder below. In the folder picker, **Command–Shift–G** lets you paste the path:

   ```text
   ~/Applications/Article Voice.app/Contents/Resources/ChromeExtension
   ```

4. Click **Try a reading** in the app, or open an article and click Article Voice in Chrome's Extensions menu. Press **Play**.

This is an **ad-hoc signed, unnotarized developer preview**. If macOS blocks opening it, review [Apple's instructions for opening a trusted downloaded app](https://support.apple.com/en-us/102445), including **System Settings → Privacy & Security → Open Anyway**. No Chrome Web Store listing is available. Chrome's [unpacked-extension installation](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#load-unpacked) requires Developer mode to remain enabled.

The separate **Article-Voice-Chrome.zip** download contains the same extension for manual installation. Unzip it into a permanent folder and choose that folder with **Load unpacked**; the Mac app is still required for local voices. The app's bundled extension is the recommended preview setup.

## Reading

- **Optional text preparation:** **Improve text formatting** is on by default. A small local LLM repairs formatting before speech and alignment; content-changing responses retain the original. Turn it off to bypass the model entirely, with source highlighting preserved.
- **Continuous OCR reading:** line wraps and an unfinished page tail reach the LLM together with available continuation text, before speech is split. Joined words keep their page coordinates, and continuation text is voiced once.
- **Nine voices** use permanent reference recordings to keep the speaker consistent across passages and articles.
- **Minimal / Compact / Full** buttons switch between a thin audio bar, a compact player, and a player with settings. All three include **Follow words**.
- **Word highlighting and seeking:** the current passage stays green, the spoken word is yellow, and clicking a word moves playback there.
- **Your scrolling takes priority:** manual scrolling pauses automatic page following for ten seconds after your latest gesture. Speech and word highlighting continue.
- **Kindle follows its own navigation:** turning a page or changing the book layout reconnects the reader automatically and rebuilds the queue. Playing continues from the start of the newly visible page; a paused reader stays paused.
- **Listen as passages are ready** is the default. Full view also offers **After the whole article is ready**, useful when generation cannot keep up at 3×.
- **Independent local caches** reuse speech for the same text, voice and language, and reuse measured alignment separately. Source coordinates are projected afresh. Speed changes do not generate new audio. Save WAV and Open saved audio can preserve a reading with its word timings.

After setup, you can close or quit the Mac app. Chrome starts the bundled speech helper when needed; it exits after ten minutes without requests. No terminal command, API key, or Accessibility permission is required. Once models are installed, speech works offline for articles already available in Chrome.

To update, install the newer app, click **Reload** on Article Voice in `chrome://extensions`, and refresh your article tab. Models and saved voice references remain installed. If the extension is removed or disabled, the app offers **Reconnect Chrome** after its connection check expires; Chrome may clear the extension's saved audio on removal.

## Local speech and privacy

Current source builds optionally prepare content with **Qwen3 1.7B at 4-bit**, then use **Qwen3-TTS 1.7B Base at 4-bit** through MLX-Audio and **Qwen3-ForcedAligner 0.6B** for measured word timings. Each preset uses the same reference recording and transcript across passages. Model revisions, generation settings, download sizes, and SHA-256 digests are pinned in [`local/config.json`](local/config.json) and [`local/model-files.json`](local/model-files.json).

Article text and generated speech stay on this Mac in the app flow. Setup downloads public model files from Hugging Face. There is no analytics, telemetry, paid API requirement, or automatic cloud fallback. The extension stores preferences locally and caches audio in IndexedDB with a 128 MB budget. Clearing audio cache retains the voice references.

Chrome permissions cover reading a page after you invoke the extension, local storage, background connection checks, and Native Messaging. The code also retains an optional Cartesia development adapter and its API host permission; the Mac reader fixes the provider to local speech and exposes no model/provider selector. Native speech uses the app-managed loopback engine on port **4324**. The standalone developer endpoint on **4318** remains independent.

## Limitations

The article adapter reads text exposed in the page DOM. The Kindle Cloud Reader adapter also reads visible page images through local Apple Vision OCR, prepares two pages ahead, and turns pages after audio completes; see [source adapters](docs/source-adapters.md). Other canvas-only text, Chrome internal pages, the Web Store, Chrome's built-in PDF viewer, and cross-origin embedded articles are unsupported. Paywalled content must already be visible to you. Complex or changing pages may need the reader reopened. Native Kindle and other Mac apps remain unsupported.

Speech begins passage by passage after generation and alignment, rather than playing the first raw audio packet. Faster playback may wait for generation to catch up. Reference conditioning improves speaker consistency but does not guarantee identical perceived timbre in every sentence. English and Chinese output have been exercised; other model languages remain unverified.

## Develop

Use the Node version in `.nvmrc` and npm version in `package.json`. For speech and app builds, also use Python 3.12, `uv`, Apple Silicon, and the macOS 26 Swift toolchain.

```sh
git clone https://github.com/zhoutongchar/article-voice.git
cd article-voice
npm ci
npm run check
npm run dev
```

Open `http://127.0.0.1:4317` in Chrome. **Test player UX** and **Run browser checks** exercise the production reader modules with a recorded fixture. Fixture timestamps do not establish real model alignment accuracy. Development servers and test code are excluded from the extension build.

For real local speech:

```sh
npm run local:setup
npm run local
```

The standalone server binds only to `127.0.0.1:4318`. First startup prepares nine permanent voice references and downloads pinned narrator, reference-generator, and aligner weights (about **6.91 GB** total for development). The installed app instead includes prepared references and downloads the narrator and aligner (**3.61 GB**); the optional passage formatter adds **0.99 GB** on first enabled use. Once the standalone server reports ready, **Open local reader** and **Test local Qwen** in the browser harness use real speech. Stop the server with Control-C.

To package the Mac app after the references are prepared:

```sh
npm run mac:build
```

See [`macos/README.md`](macos/README.md) for the bundle layout, native protocol, and signing requirements. No release signing identity is included in this repository.

Additional checks:

```sh
.venv/bin/python -m unittest discover -s tests -p '*_test.py'
npm run mac:check
```

The optional Cartesia live-development check reads `CARTESIA_API_KEY` from a gitignored `.env`; see `.env.example`. Never commit credentials or generated model caches.

For headless performance measurements from assembled synthetic content, see the
[pipeline latency investigation](docs/latency.md). It compares chunk concurrency,
speech batching and optional backend alignment prefetch without changing Chrome.

## Verification

The 0.8.0 contract refactor passes **76 JavaScript tests, 44 Python tests and 48 native checks**. Draft 2020-12 schemas and examples validate, and the published TypeScript declarations pass strict checking. Real-model Chrome fixtures exercised formatter-disabled playback with no formatter weights present, whole-window OCR formatting with a cross-page word, source highlighting, sentence-boundary playback and seeking. An ordinary HTTP page also passed the three-layout, whole-article and ten-second scroll checks. The installed 0.8.0 Chrome sample also passed playback, original-source highlighting, paragraph progression, formatter bypass and 3×. Live Kindle OCR, highlighting and lookahead worked; the Mac locked before its automatic page turn could be verified. See [pipeline verification](docs/pipeline.md#verification-scope) for the distinction between browser fixtures, native transport and installed-extension coverage.

The 0.7.0 source enables [whole-passage preparation](docs/text-cleanup-experiment.md)
before local speech and alignment. The installed Chrome reader, real native
protocol and six-passage browser comparison passed with original-source
highlighting, word seeking, content-preserving fallbacks and pitch-preserving
playback. JavaScript checks
passed 57 tests and Python checks passed 33 tests.

The 0.7.1 continuous OCR fixture passed with actual Apple Vision, the local LLM,
Qwen speech and forced alignment, including a word split across page images,
automatic presentation and no repeated continuation text. JavaScript checks
passed 63 tests and Python checks passed 35 tests. This fixture is separate from
live Amazon Kindle; see [the verification scope](docs/text-cleanup-experiment.md#verification-scope).

The 0.7.2 browser checks keep a 591-character HTML paragraph in one real Qwen
request, play through the reported phrase with source highlighting, and keep a
multi-sentence OCR continuation in one request across pages. JavaScript checks
passed 65 tests, Python checks passed 37 tests, and native checks passed 48.
Paragraph grouping and model-limit behavior are described in
[the preparation notes](docs/text-cleanup-experiment.md).

In 0.7.3, paragraphs over 1,500 UTF-16 characters use complete-sentence grouping;
ordinary paragraphs remain intact. The real Chrome/Qwen test played across a
long paragraph's sentence boundary with source highlighting and word seeking.
JavaScript checks passed 67 tests and Python checks passed 38 tests.

For the 0.5.1 preview, prior local verification passed JavaScript checks and browser harness checks for the three layouts, playback continuity, whole-article mode, and the ten-second scroll suspension. The minimal player measured **480 × 52 CSS pixels**. Real Qwen checks exercised speech, measured alignment, nine voices, word seeking, cached replay, and playback around 3× on the test Mac. The user also confirmed that the installed extension's sample reading works.

For the 0.6.5 source, the installed extension was tested on Kindle Cloud Reader with local Qwen speech and Apple Vision OCR. Playback completed four consecutive automatic page turns at 2.25×, with source word highlighting and two-page audio preparation/refill. Manual page turns while stopped, paused, or playing and a fullscreen layout change reconnected to the visible page without the former fatal error. Word seeking, resume after reconnection, and Stop clearing playback and marks while leaving Kindle controls available were checked. A page/layout change starts reading from the beginning of the newly visible page; it does not locate the old spoken word across reflow.

At 0.6.5 the JavaScript suite passed 54 tests. The browser source fixture separately checks two-page preparation/restoration, 3× playback, identical-image repaints, manual navigation while paused and playing, layout changes, cancellation during reconnection, retry, and cleanup. Native Chrome window controls preserve the installed player; claiming its tab through browser automation can interrupt the extension frame. Live compatibility has been exercised on one book and Mac, not every Kindle title or layout.

The browser harness uses production reader modules with a development transport; it does not itself establish installed-extension behavior. Model download resume and integrity are tested with a controlled HTTP server; a complete uncached 3.61 GB download has not been repeated. Signing/notarization and a clean-machine install remain unverified.

## Credits

Artifact hashing uses [Noble Hashes](https://github.com/paulmillr/noble-hashes), with its bundled MIT notice. Article extraction uses [Mozilla Readability](https://github.com/mozilla/readability), with its [Apache-2.0 notice](public/READABILITY-LICENSE.txt). Passage preparation uses [Qwen3](https://huggingface.co/Qwen/Qwen3-1.7B) and [MLX-LM](https://github.com/ml-explore/mlx-lm). Speech uses [Qwen3-TTS](https://github.com/QwenLM/Qwen3-TTS), MLX Community quantizations, and [MLX-Audio](https://github.com/Blaizzy/mlx-audio). Model attribution and bundled third-party notices are in [`macos/Resources/Licenses`](macos/Resources/Licenses). This is an independent implementation and does not use Lisen code or branding.
