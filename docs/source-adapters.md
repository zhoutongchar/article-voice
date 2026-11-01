# Reading source adapters

The source adapter owns the website. The common reading session owns the queue. The voice provider owns synthesis. These are separate choices: adding a source does not add another player or speech engine.

```text
Source registry → site adapter → reading units → shared session → ReaderEngine → voice provider
                       ↑                              │
                       └──── present / word spans ─────┘
```

## Source contract

Register a specialized source before the generic article fallback in `src/sources/registry.js`. A registration has an ID, a URL matcher, and a factory. Mark an image-reading registration with `imageReading: true`; the background bridge uses that same registry to authorize OCR requests. Matching never starts recognition or navigation.

The factory receives the page document, URL, an abortable image recognizer, and an external-change callback. It returns:

| Member | Responsibility |
| --- | --- |
| `id`, `capabilities` | Declare pagination, prefetch with visible-position restoration, scrolling support, `format: 'ocr'` for image text, and an optional preparation notice. |
| `open()` | Return the current reading unit. |
| `current()`, `has(id)` | Own the current position and retained unit identities. |
| `prepareNext(afterId, count)` | Prepare up to two following units and restore the displayed position before resolving. |
| `present(id)` | Present a retained unit when playback reaches it. |
| `span(block, start, end)` | Return text and either a DOM Range or image word rectangles for a UTF-16 source span. |
| `wordAtPoint(x, y)` | Map a click back to a block and UTF-16 source span. |
| `cancel()` | Cancel pending work and finish position restoration. |
| `dispose()` | Finish cancellation/restoration and release observers, covers, and input locks. |

A unit has an opaque stable ID, title, URL, language, optional position label, and ordered text blocks. The adapter retains its DOM nodes, image pixels, geometry, and navigation anchors. `SourceHost` sends only serializable unit data to the player. The player never interprets Kindle locations or site selectors.

## Shared queue

`ReadingSession` retains up to two future units with the same voice settings as the current unit. OCR startup fetches one continuation page first; further acquisition runs in the background. `WorkQueue` serializes preparation and voice requests and gives current playback priority over pending background work. Cached audio and ready engine results move into the current engine without generation being repeated. Speed remains a playback setting.

For local OCR, `continuousUnit` joins an unfinished page tail with the following sentence before the LLM sees it. Original lines retain newlines, including wrap hyphens. The entire assembled reading window is prepared once, then split into speech pieces at sentence boundaries where possible. A consumed-prefix ledger prevents that continuation from being voiced again on its original page. Committed narration is never rewritten when later pages arrive. This uses the available lookahead, not unlimited book context; very long continuations can exceed that window.

Prepared words retain their original page/block coordinates. The session presents a continued page when its first measured word begins, briefly pausing audio while the source completes navigation. Other sources present the next unit after the current audio completes. Streaming mode requires the next unit's first piece, rather than its entire audio, before advancing. A promoted background engine is cancelled after its ready audio is transferred.

Pause stops automatic progression; Stop invalidates pending work and waits for source restoration. Voice/language changes discard prepared readings. A recognized external page/layout change replaces the source, discards its old queued units, and opens the visible page automatically. Playing resumes from the start of that visible page; a paused or stopped reader stays paused. Stop or Close during reconnection prevents late playback. Actual capture/navigation failures remain errors. Queue audio has a 128 MB budget; the source retains one previous image unit and two future units.

## Implementations

- **Article:** the existing Mozilla Readability extractor, DOM ranges, and original-page word seeking now live behind the article adapter. Wikipedia can already use this fallback. It has one unit and does not paginate.
- **Kindle:** reads the current rendered page image, recognizes it locally through the bundled Apple Vision helper, orders columns, and maps word positions back onto the image. It uses normal page controls to visit up to two future pages, holds the current image over the book during preparation, and returns to the displayed position before resolving. It does not depend on Kindle’s private cache or Copy service. The controls remain accessible through the Article Voice player during preparation. If the source cannot confirm its position, reading stops with an explicit recovery message and Kindle controls are released.

Kindle unit identity combines the book ID and captured image digest. The optional location label is display metadata: Kindle can hide or update it independently of the image, so it must not participate in position verification.

The page observer also uses this content identity. A new blob URL or a temporarily removed image triggers a settled capture, not immediate invalidation. An identical image keeps the prepared reading and refreshes marks. Different image contents emit a page-change event: the invalid old source is disposed without restoring its former position, and the content host creates a fresh adapter at the visible page. Source replacement remains in the page; the shared session preserves playback intent. Observer verification is cancelled when owned page traversal begins. Actual failure reasons survive transport and a later Play attempt.

Opening verifies the captured image again after OCR. If the user turns another page during recognition, it recognizes the newer image before publishing any text or coordinates. A reading never starts with word boxes from the previous page.

Kindle's chevron containers handle mouse press/release for navigation. The adapter sends one bubbling `mousedown`/`mouseup` gesture through those DOM handlers and verifies a completed image change. A synthetic `click()` alone only reaches metrics listeners in the inspected reader build and does not navigate. The gesture fixture preserves that distinction.

A new image can appear before Kindle accepts another turn. The inspected reader throttles each direction for 100 ms and also has a renderer busy gate. Capture and navigation therefore share one readiness check: the loading indicator must clear, page-view animations must finish, and the image must stay stable for 125 ms. Restoration uses this same boundary for each backward turn. Restoration errors preserve their underlying reason instead of discarding it.

The Kindle prefetch mechanism temporarily visits upcoming pages, so Amazon may record those pages as visited. Restoration returns the visible page; it does not promise to undo Kindle’s reading-history synchronization. Resizing or changing Kindle layout rebuilds the reading for the newly visible page. It currently restarts that page rather than locating the old spoken word across reflowed page boundaries.

## Adding another source

A Wikipedia-specific adapter could select article sections and exclude citation/navigation widgets while reusing DOM spans. A YouTube adapter could provide transcript sections with internal timestamp anchors and seek the video in `present()`. Those adapters can use the same voice generation, cache, queue, speed, and controls. A YouTube transcript adapter is not implemented by this change.

Avoid declaring prefetch support until the adapter can prepare units while restoring the displayed position. Source-specific acquisition, navigation, or layout work belongs in the adapter, not in `ReaderEngine` or the player.

## Verification

Run `npm run check`, the Python boundary suite, and `npm run mac:check`. Build the OCR executable with `swift build --package-path macos -c release --product ArticleVoiceOCR`.

Run `npm run dev`, open `http://127.0.0.1:4317/tests/source.html`, and choose **Run adapter checks**. This uses the production Kindle adapter, actual Apple Vision OCR, and explicitly labelled recorded speech. It checks queued units, source restoration, word marks, 3×, page completion, pause, stop, and cleanup. Add `?local=1` to use real Qwen through the app-managed engine. This fixture is not the Amazon website and does not establish live Kindle compatibility.

Use `?local=1&fresh=1&continuous=1` for the real OCR/LLM/speech continuation fixture. It puts `re-` on one page and `markable` on the next, then checks reconstruction, measured page presentation and no duplicate continuation speech. Development-only `&port=4326` selects a separate test engine.

The browser fixture starts with no location label, restores it after capture, and delays labels on alternating pages. It also revokes decoded image URLs, binds navigation to container mouse press/release, and refuses more navigation while a delayed loading indicator remains after the new image appears. This checks restoration against Kindle's readiness boundary as well as the gesture boundary.

It also replaces the current image with identical pixels under a new URL, changes to a genuinely different page while paused and while playing, and changes the rendered image dimensions. Repaints preserve prepared audio; page/layout changes must reconnect without a fatal error and preserve playback intent.

For a live installed-extension test, use native Chrome window controls rather than a browser-automation tab claim: the latter can replace protected extension frames with `srcdoc`. Keep the Mac unlocked, open the compact player, confirm upcoming pages become ready, let audio complete across multiple spreads, and verify source word marks, pause/resume and Stop. Record actual page labels and screenshots. A locked Mac prevents this live check; fixture results alone do not replace it.
