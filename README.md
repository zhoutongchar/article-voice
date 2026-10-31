# Article Voice

A separate Chrome extension for listening to web articles with Cartesia or local Qwen3-TTS voices. It supports **0.5×–3× pitch-preserving playback**, highlights the spoken word on the original page, and scrolls to keep that word visible.

An independent implementation; it does not use Lisen code or branding.

## Install

The ready-to-load extension is in `dist/`.

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select `/Users/tong/Desktop/code/article-voice/dist`.
4. Open a normal article tab and click **Article Voice** in Chrome’s Extensions menu. Pin it for quicker access.
5. Open **Settings** and choose a voice provider. For Cartesia, paste your API key and click **Connect**. For local Qwen, start the companion below and choose **Qwen3-TTS · on this Mac**.
6. Press Play. Choose **3×** from the speed menu. **Follow words** controls automatic scrolling.

Click a word in the article to start listening from that word, or jump backward/forward during playback. The selected speed stays in effect. Dragging to select text, modified clicks and links keep their normal behavior. A passage that is not ready is generated before seeking to its word timestamp; an unavailable word timing is reported rather than guessed.

After rebuilding, use **Reload** on the extension’s card, then close and reopen the on-page player.

Version 0.2.3 supports Cartesia and local Qwen. A saved selection for a removed provider automatically returns to Qwen and restores the saved Qwen voice where available. Obsolete provider profiles are removed; cloud credentials and playback preferences are retained. The Qwen endpoint remains `http://127.0.0.1:4318`.

## Local Qwen3-TTS on Apple Silicon

The local companion uses MLX-Audio 0.6.3, the 4-bit Qwen3-TTS 1.7B Base model with a fixed voice reference, and Qwen3-ForcedAligner 0.6B to measure word timestamps from the generated audio. The CustomVoice model creates a permanent reference recording once for each preset; it is released before loading the narrator. Model revisions and generation settings are pinned in `local/config.json`. The Mac needs Apple Silicon and sufficient available memory; this checkout was verified on an M5 Max with 36 GB.

```sh
cd /Users/tong/Desktop/code/article-voice
npm run local:setup  # first setup: isolated Python 3.12 environment
npm run local       # keep this terminal open while reading
```

First startup downloads the model weights to Hugging Face’s local cache (several GB). Later starts reuse those files. The service binds only to `127.0.0.1:4318`; it is not exposed to your network. Stop it with Control-C. No service is installed to start automatically.

The installed model files total about **5.93 GB**: Base narrator 2.34 GB, CustomVoice reference generator 2.31 GB, and word aligner 1.28 GB. The reference generator is not loaded on later starts when all nine saved references are present. The Python environment adds about 0.6 GB; RAM use is separate from these disk sizes.

Each preset has one reference recording and its exact input transcript in `.cache/voice-references/`. Every paragraph and preview uses the same recording for that preset, across articles and server restarts. Saved reference audio is checked against its content digest. A changed reference cannot silently replace a cached voice; reconnecting loads its current identity. The speech cache includes the reference identity and generation settings, so the older independently generated paragraph recordings are not reused. **Clear cache** removes saved article audio and retains the fixed voice references.

Natural intonation and rhythm can still vary with text. Fixed reference conditioning does not guarantee identical perceived timbre in every sentence. English and Chinese output are exercised here; other target languages remain unverified. Choose the article language explicitly when appropriate.

Reload the extension in `chrome://extensions`, refresh the article tab, then open **Settings → Voice provider → Qwen3-TTS · on this Mac**. Select **Ryan** or **Aiden** for native English, **Serena**, **Vivian**, or **Uncle Fu** for native Chinese; all nine speakers can read the supported languages. **Connect local server** retries a stopped/unavailable connection. Cartesia settings are retained separately when switching providers.

Local speech has no per-character API fees. It uses the Mac’s GPU, memory and electricity. Article text goes to the loopback companion, and speech plus alignment run on this Mac. There is no fallback to a paid provider. Normal-speed audio is generated once; 3× is local playback. If generation cannot keep up with listening at 3×, use **Generate all** or **After the whole article is ready**. Voice quality and waiting time depend on the model and text.

The ten Qwen languages are English, Chinese, Spanish, French, German, Japanese, Korean, Portuguese, Italian and Russian. Choose the language explicitly when Auto is unsuitable. Qwen’s built-in voices differ from Cartesia voices; this does not clone Cartesia voices.

## Features

- Mozilla Readability extracts the main article. Source coordinates map the result back to the original text, including links and inline formatting.
- Cartesia Sonic 3.6, 3.5 and 3 are selectable. The voice picker offers female, male and neutral types; warm, calm, expressive, narration and conversational style searches; language filtering; and pagination. Types/descriptions come from Cartesia, and an empty filter preserves your selected voice. Reopening Settings refreshes the library instead of showing only one saved voice.
- **Preview voice** plays a short sample at normal speed and pauses article playback so the sounds do not overlap. Cartesia previews use credits; local Qwen previews run on the Mac. Both are cached for reuse.
- The first passage plays as soon as it is generated. Up to two more passages are prepared ahead. **Generate all** or the ahead-of-time mode prepares the complete article.
- Word timing comes from Cartesia’s original-text timestamps or the local Qwen forced aligner. The green passage highlight stays stable within a paragraph; the yellow word marker holds through breath/punctuation gaps and moves when the next word starts. Both follow the audio’s media clock, including at 3×, after seeking, and after pause/resume. Unmatched words have no fabricated highlight.
- Speed changes are local and preserve pitch. They reuse generated audio.
- A local audio cache avoids generating the same text again with the same voice, model and language. **Clear cache** removes persisted recordings. Active readings and persisted cache each have a 128 MB budget.
- **↓ WAV** exports normal-speed audio with embedded word timings. **Settings → Open saved WAV** restores read-along on a page with exactly the same article text; no API key is needed for the imported recording.
- Closing or leaving the page stops playback. **Stop** cancels generation; a provider may still charge for audio already generated.

## Data and permissions

Cartesia mode contacts `https://api.cartesia.ai`. Local Qwen mode contacts the companion at `http://127.0.0.1:4318`; the companion downloads public model files at setup and performs inference locally. The local server does not accept browser requests from unrelated websites.

The API key and preferences stay in `chrome.storage.local`, restricted to trusted extension contexts. They are not synced to Chrome Sync. Audio and timing data are cached in the extension’s IndexedDB. **Forget key** removes the saved key. Cartesia receives article text only when you play or generate audio; voice lookup sends the key and search query to Cartesia.

Permissions are `activeTab`, `scripting`, `storage`, and access to the Cartesia API and loopback host. Page access starts when you click the extension; it does not request permanent access to every site. There is no analytics or telemetry.

## Develop and verify

```sh
PATH="/usr/local/bin:$PATH" npm ci
PATH="/usr/local/bin:$PATH" npm run check
PATH="/usr/local/bin:$PATH" npm run dev
```

Open `http://127.0.0.1:4317` in Chrome and click **Run browser checks**. The development page runs the same extraction, player, alignment, cache-key and playback modules, with an isolated test bridge and a recorded speech fixture. Test code and the local server are excluded from `dist/`.

The fixture verifies browser behavior; its evenly distributed test timestamps do **not** establish Cartesia pronunciation or live timestamp accuracy. The test panel labels this mode explicitly.

With the local companion running, click **Open local reader** to read the full public article with real Qwen speech. **Test local Qwen** verifies actual local generation of three public article paragraphs, shared-reference identity, measured alignment, playback, pause, word clicks, 3×, paragraph transitions and persistent-cache reuse. This test does not use the recorded fixture. Run `.venv/bin/python tests/local_server_test.py` for loopback HTTP boundary checks and `.venv/bin/python tests/voice_reference_test.py` for reference persistence and runtime conditioning checks without loading speech models.

To run the live service check, place a key in the project’s gitignored `.env`:

```dotenv
CARTESIA_API_KEY=your_key_here
```

Then click **Test live Cartesia**. The loopback-only test proxy reads the key without returning it to the page and sends one public test paragraph through Cartesia’s real SSE endpoint. It tests playback, timestamp-based highlighting and 3× speed. It does not put the key in the installed extension; connect that separately in its Settings. The default live-test voice is the public voice in Cartesia’s current API example; set `CARTESIA_VOICE_ID` in the development server’s environment to use another voice.

## Verification so far

- Version 0.2.3 `npm run check`: build and 31 code tests passed, including recovery from a removed saved provider without switching to cloud generation.
- Version 0.2.3: Qwen and recorded-fixture Chrome suites passed after removing the experimental provider. Qwen playback measured 2.97× with pitch preservation; word clicks, three-paragraph reference consistency, page highlighting, cache replay, nine voices and provider switching passed. Qwen remained ready on port 4318; the retired companion on port 4319 was stopped. Browser reports are in `test-results/qwen-baseline/`. These use the development harness; the installed-extension limitation below still applies.
- Chrome browser suite: all checks passed using recorded audio; latest measured playback rate **2.97×** with pitch preservation enabled.
- Browser checks covered extraction, audio playback, original-page word and passage highlighting, speed changes without regeneration, pause/resume, automatic scrolling and its toggle, complete generation, timeline seeking, WAV export/reimport, and Stop cleanup.
- The browser suite also verified a new reading reuses audio from real IndexedDB. Chrome’s WAV download was checked on disk: valid 24 kHz mono PCM with 524 word timings across 19 source blocks. Automating a file-picker selection needs an additional permission in the browser-control extension; in-memory WAV export/reimport passed.
- Added browser regressions for stable highlight objects/ranges through word timing gaps, multiple voice choices, gender/style/empty filters, saved selection, and preview playback. The demo has three distinct recorded test voices and explicitly labels them; those are not Cartesia quality samples.
- Word-click browser regressions pass for forward/backward seeking at 3×, inline formatted words, selection/link/whitespace guards, and reopened WAV recordings. A real mouse click on the article also moved playback and the original-page highlight to the clicked word. Code tests cover a later click superseding an unfinished seek and tab-specific message routing.
- Version 0.2.1: real Qwen Base narration of three English paragraphs used the same reference identity. Browser checks passed for word clicks, pause, persisted-cache reuse, 3× playback (measured 2.97×), automatic paragraph transitions and matching page highlights. Nine voice choices and provider-switch settings restoration passed. Two Chinese paragraphs used the same Serena reference. All nine reference identities and WAV modification times were unchanged after a real server restart. Other target languages remain unverified.
- Five HTTP boundary checks and five reference/runtime checks passed. The latter covers persistence, changed-reference detection, voice/recipe identity and conditioning each paragraph on the same reference audio plus transcript.
- Current fixed-reference English samples contain 12.64–14.96 s of audio, generated and aligned in 2.29–4.28 s. Chinese samples contain 12.16–14.16 s, generated and aligned in 2.22–3.06 s. These short samples do not establish throughput for every article or language.
- Audio, raw results and browser reports are in `test-results/voice-consistency/`. A small comparison using Qwen's own speaker encoder was inconclusive and does not establish audible improvement; see `speaker-comparison.json`. The three-paragraph listening sample is `fixed-ryan-three-paragraphs.wav`.
- Screenshots: `test-results/browser-3x.png`, `test-results/local-qwen-browser.png`, and `test-results/voice-consistency/fixed-reference-browser.png`.
- **Pending:** real Cartesia generation and an installed-extension smoke test. A Cartesia key was unavailable, and browser automation could not access Chrome’s extension manager. Those are separate from the passing fixture-based browser test.

## Limits

Chrome’s internal pages, Web Store, built-in PDF viewer, cross-origin embedded articles, and text not exposed in the page DOM are not supported. Paywalled content must already be visible to you. Complex pages and articles that rewrite themselves may need the player reopened. The reader does not bypass access controls.

At 3×, pitch is preserved, but naturalness and intelligibility depend on the voice and listener. Streaming here means passage-by-passage playback with prefetch, rather than playback of the first raw PCM packet. If generation cannot keep up, playback waits for the next passage.

Mozilla Readability is distributed under Apache-2.0; its license is included in `dist/READABILITY-LICENSE.txt`.
