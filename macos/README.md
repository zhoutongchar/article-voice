# Article Voice for Chrome on Mac

One Mac app installs itself, prepares its local voices, and connects a Chrome extension. The Chrome reader highlights words on the original page, scrolls with the speech, supports clicking words to seek, and preserves pitch from 0.5× to 3×. Three icon buttons switch between a thin single-row minimal bar, compact view, and full view. All include Follow words; full view includes voice choices, language, and listening mode. Playback starts as passages are ready by default, with an option to prepare the whole article first. Manually scrolling pauses automatic following for ten seconds after the latest gesture while speech and highlighting continue. The Mac reader uses its bundled engine without provider or model controls.

Requires Apple Silicon and macOS 26 or later. This build has been exercised on an M5 Max with 36 GB RAM. There is no Accessibility or screen-recording setup in this product. The earlier system-wide reader source is retained but excluded from the app target.

## User setup

1. Download and open **Article Voice**. Choose **Install Article Voice**. It installs into the user's Applications folder and reopens itself.
2. Voices prepare automatically. First setup downloads 3.61 GB of pinned narrator and aligner files; the optional formatter adds 0.99 GB on first enabled use, with progress, pause/resume, and SHA-256 verification. Already verified files are reused; an existing Hugging Face model cache is imported without downloading it again. Nine permanent voice references are included in the app.
3. Choose **Connect Chrome**, add the extension, and start reading. The app detects the extension's background heartbeat through its native host. Its welcome page includes **Try a reading**, which opens a bundled sample article and its reader.

After setup, the Mac setup window can be closed or the app quit. Chrome starts the bundled speech helper on demand. Its local engine exits after ten minutes without requests and restarts when needed. No Python installation, terminal command, API key, or separate model management is needed.

### GitHub preview and store distribution

The [GitHub preview release](https://github.com/zhoutongchar/article-voice/releases/tag/v0.8.1) distributes the app ZIP and extension ZIP, including optional full-passage formatting, Kindle OCR and default alignment prefetch. It is ad-hoc signed and unnotarized. A published Chrome Web Store listing and a Developer ID signing identity are not available. Connect it once by loading its `Contents/Resources/ChromeExtension` directory with Chrome's **Load unpacked** action. The built app includes this directory. Chrome Developer mode must remain enabled. See the root README for the complete installation steps and macOS opening guidance.

For a future store release, upload `macos/build/Article Voice Chrome.zip` to the Chrome Web Store. Use the listing's extension ID and public key in `chrome/connection.json`, and set its HTTPS `storeUrl`. The ID must match that public key. The app's Connect Chrome button then opens the real listing. Chrome still requires the user to approve installation.

A distributable Mac build also needs Developer ID signing and notarization. Set `ARTICLE_VOICE_SIGN_IDENTITY` and `ARTICLE_VOICE_NOTARY_PROFILE`, then build with `--release`. That mode fails early if release configuration is incomplete. The signing/notarization path has not been exercised here; preview signing has passed.

## Architecture and privacy

Content chunks flow through an optional Qwen3 1.7B formatter, paragraph planning,
Qwen3-TTS, forced alignment and source projection. **Improve text formatting**
is enabled by default; turning it off passes content through unchanged.
Post-inference checks accept formatting repairs or retain the original content.
See [pipeline contracts](../docs/pipeline.md) for the versioned data shapes,
independent caches, cancellation and resource scheduling.

The bundled voice engine enables alignment prefetch by default: new paragraph
audio gets measured word timings before the next speech job begins. This lowers
first-playable latency in the measured fixtures, with slightly slower total
generation. The standalone engine supports `--no-prefetch-alignment`; a reused
upstream endpoint keeps its own setting. The backend health response exposes
`alignmentPrefetch`, including an explicit unknown for older upstream engines.

- The app registers `com.articlevoice.chrome` in the user's Chrome NativeMessagingHosts directory, restricted to the configured extension ID. An existing changed manifest is backed up before replacement.
- Chrome's native host is a small executable inside the app. It runs the bundled Python runtime and supports heartbeat, status, voice catalog, OCR and separate format, synthesis and alignment operations. Legacy combined operations remain adapters. It does not expose a general command interface.
- Native audio messages are split below Chrome's 1 MB host-to-extension limit. Closing the port cancels that request. Unknown callers and oversized or malformed native messages are rejected.
- The Chrome engine uses loopback port **4324**. The earlier native preview on 4320 and Chrome Qwen endpoint on 4318 are independent. A ready compatible endpoint on 4318 can be reused through the lightweight gateway; it is never stopped or replaced.
- Models install under `~/Library/Application Support/Article Voice/Models`. Setup progress and engine logs live in that app directory. They do not contain article text. A versioned heartbeat receipt records only the extension ID and last connection time. The background extension checks in every 30 seconds without starting the voice engine; Chrome may delay alarms during sleep. While the app is open, a heartbeat expires after 90 seconds. Removing or disabling the extension then offers **Reconnect Chrome**, retaining the voices. Closing Chrome offers **Open Chrome**. Launch and wake allow a brief connection check before showing a reconnect prompt. The app cannot distinguish a removed extension from one that is disabled or unable to reach its native host.
- Speech text stays on the Mac. Model setup downloads public files from Hugging Face; speech uses the bundled local runtime. The optional Cartesia adapter is retained for development; the Mac reader fixes the provider to local speech.
- The extension's audio cache includes the fixed voice reference identity. Playback speed changes and word seeking reuse generated audio. Ordinary paragraphs stay together; long paragraphs split at complete sentences. Listening can begin before the remaining article is generated. At 3×, generation may still need to catch up.

For OCR with formatting enabled, the whole reading window reaches the LLM before speech is split. An
unfinished page tail is joined with available continuation text; its prefix is
consumed once, and original page/word coordinates drive presentation. Audio can
start before the rest of that page's speech has finished generating.

The current app download is approximately 0.6 GB before compression, plus 3.61 GB of core model files and a further 0.99 GB for optional formatting. Final compressed sizes are reported by the build artifacts.

## Build

Use the prepared Python 3.12 environment described in the root README. Building packages that environment and the prepared nine voice references; it never installs software on the user's Mac at launch.

```sh
npm run mac:build
npm run mac:build -- --release
```

Outputs:

- `macos/build/Article Voice.app`: app and one-click installer.
- `macos/build/Article Voice.zip`: downloadable app archive.
- `macos/build/Article Voice Chrome.zip`: extension archive for unpacked installation or a future Chrome Web Store upload.

## Verification

```sh
npm test
.venv/bin/python -m unittest discover -s tests -p '*_test.py'
swift run --package-path macos ArticleVoiceCoreChecks
```

The setup suite exercises real HTTP range resume, servers ignoring ranges, digest rejection, verified cache reuse, framing, native origin checks, and heartbeat recording without waking the speech engine. JavaScript tests exercise alarm/startup/retry behavior, native audio chunk assembly, aborted/disconnected ports, incomplete messages, source coordinates, word seeking, speed, cache identity, and existing provider behavior. Swift checks cover heartbeat expiry, reconnection, closed Chrome, startup/wake grace, and legacy, malformed, foreign, or future receipts. No test removes the user's extension.

The real app install, cached model preparation, cold local-engine startup, nine-voice catalog, and fresh Qwen speech through the production native-host protocol passed on this Mac. A real pinned configuration file also downloaded from Hugging Face and passed its packaged digest check. Resume mechanics use a controlled HTTP server; a full uncached 4.60 GB network download has not been repeated.

The app-installed native host also restarted a stopped, verified test-owned voice engine with the setup app closed, returning nine voices in 3.8 seconds. A separate gateway exited cleanly after its idle timeout while preserving the production engine.

The real browser harness passed against the app-managed engine: speech, measured alignment, word clicks across audio pieces, cache replay, reference consistency, paragraph transitions, nine voices, and measured 3.00×–3.02× playback. This uses the production reader modules with the development browser transport.

During installed-extension inspection, its frame retained its extension URL but gained an empty `srcdoc`. This matches the symptom in [Codex issue #58116](https://github.com/openai/codex/issues/58116), which suggests browser-control interference without establishing the cause on this Mac. The reader detects this interruption, clears source markers, and provides recovery instructions with a working Close button; this failure path passed in the browser harness. The user subsequently confirmed that the installed extension's reading test works in ordinary Chrome. This is user confirmation, not an automated installed-extension playback check.

Local QA reports and screenshots are kept under the gitignored `test-results/` directory. They are not included in the repository. Do not treat independent speech or browser harness checks as proof of the installed extension's complete UI path.
