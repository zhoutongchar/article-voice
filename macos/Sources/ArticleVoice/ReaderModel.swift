import AppKit
import ArticleVoiceCore
import Combine

@MainActor final class ReaderModel: ObservableObject {
    enum State { case idle, preparing, playing, paused, complete }
    @Published var state: State = .idle
    @Published var draft = ""
    @Published var sourceName = ""
    @Published var text = ""
    @Published var position = 0.0
    @Published var duration = 0.0
    @Published var currentRange: NSRange?
    @Published var passageRange: NSRange?
    @Published var error: String?
    @Published var voices: [Voice] = []
    @Published var voiceID = UserDefaults.standard.string(forKey: "voice") ?? "Ryan"
    @Published var speed = UserDefaults.standard.double(forKey: "speed") == 0 ? 1.0 : UserDefaults.standard.double(forKey: "speed")
    @Published var follow = true {
        didSet { if follow { overlay.show(currentRange, source: source) } else { overlay.hide() } }
    }
    @Published var previewing = false
    @Published var index = 0
    @Published var total = 0
    let companion: Companion
    let focus = FocusCapture()
    let shortcut = GlobalShortcut()
    private let client: SpeechClient
    private let audio = AudioPlayback()
    private let preview = AudioPlayback()
    let overlay = SourceHighlight()
    private var source: CapturedText?
    private var plan = ReadingPlan("")
    private var clips: [Int: SpeechClip] = [:]
    private var pending: [Int: Task<SpeechClip, Error>] = [:]
    private var playTask: Task<Void, Never>?
    private var prefetchTask: Task<Void, Never>?
    private var previewTask: Task<Void, Never>?
    private var setupTask: Task<Void, Never>?
    private var captureTask: Task<Void, Never>?
    private var epoch = UUID()
    private var playTicket = UUID()
    private var words: [LocatedWord] = []
    private var wantsPlay = false
    private var streamingPassage = false
    private var failedPassage = false
    var showWindow: ((Bool) -> Void)?

    init(client: SpeechClient, companion: Companion) {
        self.client = client; self.companion = companion
        speed = min(3, max(0.5, speed))
        audio.setSpeed(speed)
        audio.onPosition = { [weak self] time in self?.tick(time) }
        audio.onEnd = { [weak self] in self?.advance() }
        audio.onBuffering = { [weak self] buffering in
            guard let self else { return }
            self.state = self.wantsPlay ? (buffering ? .preparing : .playing) : .paused
        }
        preview.onEnd = { [weak self] in self?.previewing = false }
        shortcut.action = { [weak self] in self?.readSelection() }
        prepareVoices()
    }

    func prepareVoices() {
        setupTask?.cancel()
        setupTask = Task {
            do {
                voices = try await companion.prepare()
                if !voices.contains(where: { $0.id == voiceID }) { voiceID = voices.first?.id ?? "Ryan" }
                error = nil
                if wantsPlay && !text.isEmpty && duration == 0 { startPassage(index) }
            } catch is CancellationError { }
            catch { self.error = error.localizedDescription }
        }
    }

    func readSelection(focusedArea: Bool = false, from app: NSRunningApplication? = nil) {
        captureTask?.cancel()
        captureTask = Task {
            do {
                let selection = try await focus.read(focusedArea: focusedArea, from: app)
                try Task.checkCancellation()
                captureTask = nil; read(selection); showWindow?(false)
            }
            catch is CancellationError { }
            catch { if !Task.isCancelled { self.error = error.localizedDescription; showWindow?(true) } }
        }
    }

    func read(_ selection: CapturedText) {
        guard !selection.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { error = "Select a passage or paste some text to start."; return }
        guard selection.text.count <= 20000 else { error = CaptureError.tooLong.localizedDescription; return }
        stop(); source = selection; sourceName = selection.source; text = selection.text
        plan = ReadingPlan(text); total = plan.passages.count; index = 0; error = nil
        wantsPlay = true
        if companion.ready && !voices.isEmpty { startPassage(0) } else { state = .preparing }
    }

    func readDraft() { read(CapturedText(text: draft, source: "Pasted text")) }
    func paste() {
        if let value = NSPasteboard.general.string(forType: .string), !value.isEmpty { draft = value; readDraft() }
        else { error = "Copy some text first, then choose Paste and read." }
    }
    func sample() { read(CapturedText(text: "The first thing you notice is the quiet. Not silence, exactly, but the soft sound of a city waking up. A bicycle rolls past the window. Somewhere downstairs, a kettle begins to sing.\n\nWe spend so much of our time looking for the next thing that we forget to notice the thing in front of us. A walk through the neighborhood can become an entirely different experience when we leave our headphones at home.", source: "Sample reading")) }

    func toggle() {
        switch state {
        case .playing, .preparing: wantsPlay = false; audio.pause(); state = .paused
        case .paused:
            wantsPlay = true
            if failedPassage { startPassage(index); return }
            if audio.reachedEnd { advance(); return }
            if duration > 0 { audio.resume(); state = .playing } else { startPassage(index) }
        case .idle, .complete:
            if !text.isEmpty { wantsPlay = true; startPassage(state == .complete ? 0 : index) }
            else if !draft.isEmpty { readDraft() }
        }
    }

    func stop() {
        epoch = UUID(); playTicket = UUID(); wantsPlay = false
        captureTask?.cancel(); playTask?.cancel(); prefetchTask?.cancel(); previewTask?.cancel()
        for task in pending.values { task.cancel() }
        pending.removeAll(); clips.removeAll()
        audio.stop(); preview.stop(); overlay.hide(); previewing = false
        words.removeAll(); streamingPassage = false; failedPassage = false
        index = 0; position = 0; duration = 0; currentRange = nil; passageRange = nil; state = .idle
    }

    func newText() { stop(); source = nil; text = ""; sourceName = ""; plan = ReadingPlan(""); total = 0; draft = ""; error = nil }
    func changeSpeed(_ value: Double) { speed = value; audio.setSpeed(value); UserDefaults.standard.set(value, forKey: "speed") }
    func changeVoice(_ value: String) { stop(); index = 0; voiceID = value; UserDefaults.standard.set(value, forKey: "voice") }
    func jump(_ seconds: Double) {
        guard duration > 0 else { return }
        let target = position + seconds
        if target < 0 && index > 0 { startPassage(index - 1, fromEnd: -target); return }
        if target >= duration && index + 1 < total && !streamingPassage { startPassage(index + 1); return }
        do { try audio.seek(target, play: wantsPlay); tick(audio.position) } catch { self.error = error.localizedDescription }
    }
    func seek(_ time: Double) { do { try audio.seek(time, play: wantsPlay); tick(audio.position) } catch { self.error = error.localizedDescription } }
    func seekWord(_ offset: Int) {
        guard let target = plan.passages.firstIndex(where: { NSLocationInRange(offset, $0.range) }) else { return }
        wantsPlay = true; startPassage(target, wordOffset: offset - plan.passages[target].range.location)
    }

    private func getClip(_ index: Int, epoch ticket: UUID) async throws -> SpeechClip {
        if let clip = clips[index] { return clip }
        guard let voice = voices.first(where: { $0.id == voiceID }) else { throw ReaderError.unavailable }
        let task: Task<SpeechClip, Error>
        if let existing = pending[index] { task = existing }
        else {
            let passage = plan.passages[index].text
            task = Task { try await client.clip(text: passage, voice: voice) }; pending[index] = task
        }
        do {
            let clip = try await task.value
            guard epoch == ticket else { throw CancellationError() }
            pending[index] = nil; clips[index] = clip
            return clip
        } catch { if epoch == ticket { pending[index] = nil }; throw error }
    }

    private func startPassage(_ target: Int, wordOffset: Int? = nil, fromEnd: Double? = nil) {
        guard target >= 0, target < plan.passages.count else { return }
        previewTask?.cancel(); preview.stop(); previewing = false
        audio.pause(); overlay.hide(); playTask?.cancel(); prefetchTask?.cancel()
        for (item, task) in pending where item < target || item > target + 2 { task.cancel(); pending[item] = nil }
        clips = clips.filter { $0.key >= target - 1 && $0.key <= target + 2 }
        index = target; position = 0; duration = 0; currentRange = nil
        streamingPassage = false; failedPassage = false
        passageRange = plan.passages[target].range; state = .preparing; error = nil
        playTicket = UUID(); let ticket = playTicket, reading = epoch
        playTask = Task {
            do {
                if client.streaming, wordOffset == nil, fromEnd == nil, clips[target] == nil, pending[target] == nil {
                    guard let voice = voices.first(where: { $0.id == voiceID }) else { throw ReaderError.unavailable }
                    streamingPassage = true; words = []; audio.begin(play: wantsPlay)
                    var pieces: [SpeechClip] = []
                    for try await piece in await client.stream(text: plan.passages[target].text, voice: voice) {
                        try Task.checkCancellation()
                        guard epoch == reading, playTicket == ticket else { return }
                        let timeOffset = audio.duration
                        words += WordAlignment.locate(piece.clip.words, in: piece.text).map { word in
                            LocatedWord(word: SpeechWord(word: word.word.word, start: word.word.start + timeOffset, end: word.word.end + timeOffset),
                                        range: word.range.map { NSRange(location: piece.offset + $0.location, length: $0.length) })
                        }
                        pieces.append(piece.clip)
                        try audio.append(piece.clip); duration = audio.duration
                        state = wantsPlay ? .playing : .paused; tick(audio.position)
                        if pieces.count == 1 { prefetch(after: target, reading: reading) }
                    }
                    try Task.checkCancellation()
                    guard epoch == reading, playTicket == ticket else { return }
                    clips[target] = try SpeechClip.joining(pieces)
                    streamingPassage = false; audio.finish()
                    return
                }
                let clip = try await getClip(target, epoch: reading)
                try Task.checkCancellation()
                guard epoch == reading, playTicket == ticket else { return }
                words = WordAlignment.locate(clip.words, in: plan.passages[target].text)
                var time = fromEnd.map { max(0, clip.duration - $0) } ?? 0
                if let wordOffset {
                    guard let word = words.first(where: { $0.range.map { NSLocationInRange(wordOffset, $0) } ?? false }) else {
                        throw ReaderError.service("That word has no reliable timing. Try a nearby word.")
                    }
                    time = word.word.start
                }
                duration = clip.duration; passageRange = plan.passages[target].range
                try audio.load(clip, at: time, play: wantsPlay); audio.setSpeed(speed)
                state = wantsPlay ? .playing : .paused
                tick(time)
                prefetch(after: target, reading: reading)
            } catch is CancellationError { }
            catch {
                guard epoch == reading, playTicket == ticket else { return }
                streamingPassage = false; failedPassage = true; wantsPlay = false; audio.pause(); state = .paused
                if error is URLError {
                    companion.disconnected()
                    self.error = "Local voices disconnected. Choose Retry to bring them back."
                } else { self.error = error.localizedDescription }
            }
        }
    }

    private func prefetch(after target: Int, reading: UUID) {
        prefetchTask = Task {
            for next in (target + 1)..<min(target + 3, total) {
                if Task.isCancelled || epoch != reading { return }
                _ = try? await getClip(next, epoch: reading)
            }
        }
    }

    private func tick(_ time: Double) {
        position = time
        let located = WordAlignment.current(words, at: time)
        let range = located?.range.map { NSRange(location: plan.passages[index].range.location + $0.location, length: $0.length) }
        if range != currentRange {
            currentRange = range
            if follow { overlay.show(range, source: source) } else { overlay.hide() }
        }
    }

    private func advance() {
        guard wantsPlay else { return }
        if index + 1 < total { startPassage(index + 1) }
        else { state = .complete; wantsPlay = false; overlay.hide() }
    }

    func previewVoice() {
        if previewing { previewTask?.cancel(); preview.stop(); previewing = false; return }
        guard let voice = voices.first(where: { $0.id == voiceID }) else { return }
        if state == .playing || state == .preparing { wantsPlay = false; audio.pause(); state = .paused }
        previewing = true
        previewTask = Task {
            do {
                let sample = voice.language == "zh" ? "熟悉的声音，让每一段文字都更容易理解。你可以随时暂停，或按自己的节奏继续听。" : "A familiar voice makes every paragraph easier to follow. Pause whenever you need, and listen at your own pace."
                let clip = try await client.clip(text: sample, voice: voice)
                try Task.checkCancellation(); try preview.load(clip)
            } catch is CancellationError { }
            catch { self.error = error.localizedDescription; previewing = false }
        }
    }

    func clearCache() { Task { do { try await client.clearCache() } catch { self.error = "Saved audio couldn’t be cleared. Try again." } } }
    func shutDown() async { stop(); setupTask?.cancel(); await companion.shutDown() }
}
