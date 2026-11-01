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
| `id`, `capabilities` | Declare pagination, prefetch with visible-position restoration, scrolling support, and an optional preparation notice. |
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

`ReadingSession` prepares two future units with the same voice settings as the current unit. `WorkQueue` serializes actual voice requests and gives current playback priority over pending background work. Cached audio and already prepared engine results move into the current engine without generation being repeated. Speed remains a playback setting.

An adapter is asked to present the next unit only after the current audio completes. Pause stops automatic progression; Stop invalidates pending work and waits for source restoration. Voice/language changes discard prepared readings. External source changes invalidate playback, requiring a new reading. Queue audio has a 128 MB budget; the source retains one previous image unit and two future units.

## Implementations

- **Article:** the existing Mozilla Readability extractor, DOM ranges, and original-page word seeking now live behind the article adapter. Wikipedia can already use this fallback. It has one unit and does not paginate.
- **Kindle:** reads the current rendered page image, recognizes it locally through the bundled Apple Vision helper, orders columns, and maps word positions back onto the image. It uses normal page controls to visit up to two future pages, holds the current image over the book during preparation, and returns to the displayed position before resolving. It does not depend on Kindle’s private cache or Copy service. The controls remain accessible through the Article Voice player during preparation. If the source cannot confirm its position, reading stops with an explicit recovery message and Kindle controls are released.

Kindle unit identity combines the book ID and captured image digest. The optional location label is display metadata: Kindle can hide or update it independently of the image, so it must not participate in position verification.

The Kindle prefetch mechanism temporarily visits upcoming pages, so Amazon may record those pages as visited. Restoration returns the visible page; it does not promise to undo Kindle’s reading-history synchronization. Resizing or changing Kindle layout invalidates page geometry and requires reopening the reader.

## Adding another source

A Wikipedia-specific adapter could select article sections and exclude citation/navigation widgets while reusing DOM spans. A YouTube adapter could provide transcript sections with internal timestamp anchors and seek the video in `present()`. Those adapters can use the same voice generation, cache, queue, speed, and controls. A YouTube transcript adapter is not implemented by this change.

Avoid declaring prefetch support until the adapter can prepare units while restoring the displayed position. Source-specific acquisition, navigation, or layout work belongs in the adapter, not in `ReaderEngine` or the player.

## Verification

Run `npm run check`, the Python boundary suite, and `npm run mac:check`. Build the OCR executable with `swift build --package-path macos -c release --product ArticleVoiceOCR`.

Run `npm run dev`, open `http://127.0.0.1:4317/tests/source.html`, and choose **Run adapter checks**. This uses the production Kindle adapter, actual Apple Vision OCR, and explicitly labelled recorded speech. It checks queued units, source restoration, word marks, 3×, page completion, pause, stop, and cleanup. Add `?local=1` to use real Qwen through the app-managed engine. This fixture is not the Amazon website and does not establish live Kindle compatibility.

The browser fixture starts with no location label, restores it after capture, and delays labels on alternating pages. This reproduces the optional-control boundary while also revoking decoded image URLs as Kindle does.
