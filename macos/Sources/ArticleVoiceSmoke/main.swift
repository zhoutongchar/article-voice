import ArticleVoiceCore
import Foundation

@main enum Smoke {
    @MainActor static func main() async throws {
        let current = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
        let root = FileManager.default.fileExists(atPath: current.appendingPathComponent("local/config.json").path) ? current : current.deletingLastPathComponent()
        let config = try Data(contentsOf: root.appendingPathComponent("local/config.json"))
        let directory = root.appendingPathComponent("test-results/macos-smoke")
        let managed = CommandLine.arguments.contains("--managed")
        let chinese = CommandLine.arguments.contains("--chinese")
        let streaming = CommandLine.arguments.contains("--streaming")
        guard !streaming || managed else { throw ReaderError.service("Use --managed with --streaming") }
        let port = managed ? 4322 : 4318
        let client = try SpeechClient(configData: config, port: port, cache: directory.appendingPathComponent(managed ? "Managed Cache" : "Cache"), streaming: streaming)
        var companion: Companion?
        if managed {
            let resources = root.appendingPathComponent("macos/build/Article Voice.app/Contents/Resources")
            let owned = Companion(client: client, resources: resources, directory: directory.appendingPathComponent("Managed Data"), port: port)
            if CommandLine.arguments.contains("--cancel-startup") {
                for delay in [0, 300] {
                    let startup = Task { try await owned.prepare() }
                    if delay > 0 { try await Task.sleep(for: .milliseconds(delay)) }
                    startup.cancel(); await owned.shutDown(); _ = try? await startup.value
                    guard owned.process == nil else { throw ReaderError.service("Cancelled startup left an engine running") }
                }
                let original = try SpeechClient(configData: config, cache: directory.appendingPathComponent("Cache"))
                guard try await original.health().ready else { throw ReaderError.service("Original Qwen endpoint was interrupted") }
                print("PASS cancellation before and during bundled-engine startup cleans up its process; original Qwen remains ready")
                return
            }
            companion = owned
            do { _ = try await owned.prepare() }
            catch { await owned.shutDown(); throw error }
            guard owned.process?.isRunning == true else { throw ReaderError.service("The app did not start its bundled engine") }
        }
        do { try await verify(client: client, config: config, directory: directory, companion: companion, chinese: chinese) }
        catch { await companion?.shutDown(); throw error }
    }

    @MainActor static func verify(client: SpeechClient, config: Data, directory: URL, companion: Companion?, chinese: Bool) async throws {
        let managed = companion != nil
        guard try await client.health().ready else { throw ReaderError.unavailable }
        if !managed {
            let reuser = Companion(client: client, resources: directory, directory: directory, port: 4318)
            _ = try await reuser.prepare()
            guard reuser.process == nil else { throw ReaderError.service("An existing endpoint was replaced") }
            await reuser.shutDown()
            guard try await client.health().ready else { throw ReaderError.service("An existing endpoint was stopped") }
            print("PASS existing Qwen endpoint is reused and retained")
        }
        let voices = try await client.voices()
        guard voices.count == 9, Set(voices.map(\.referenceId)).count == 9,
              let voice = voices.first(where: { $0.id == (chinese ? "Serena" : "Ryan") }) else { throw ReaderError.reference }
        try await client.clearCache()
        if CommandLine.arguments.contains("--cancel-generation") {
            guard let companion else { throw ReaderError.service("Use --managed for cancellation testing") }
            let generation = Task { try await client.clip(text: String(repeating: "This passage is being prepared while the reader closes. ", count: 8), voice: voice) }
            try await Task.sleep(for: .milliseconds(500))
            generation.cancel()
            do { _ = try await generation.value; throw ReaderError.service("Cancellation arrived after generation ended") }
            catch is CancellationError { }
            catch let error as URLError where error.code == .cancelled { }
            await companion.shutDown()
            guard companion.process == nil else { throw ReaderError.service("Quit during generation left an engine running") }
            let original = try SpeechClient(configData: config, cache: directory.appendingPathComponent("Cache"))
            guard try await original.health().ready else { throw ReaderError.service("Original Qwen endpoint was interrupted") }
            print("PASS cancellation during real speech generation cleans up the bundled engine; original Qwen remains ready")
            return
        }
        var text = chinese ? "中文也可以朗读。正在说出的词语会高亮显示。你可以随时暂停、继续，或者把播放速度调到三倍。" : "A useful reader follows the actual sound. It marks the word being spoken, keeps the surrounding passage visible, and waits when you pause."
        if client.streaming { text += chinese ? " 下一段声音还在准备时，前面的文字就已经可以开始朗读。每一小段都保留真实的词语时间，不需要等到整个段落生成完成。这样既能尽早听到声音，也能按照自己的节奏继续阅读。" : " The next sentence arrives while the first one is playing. Every piece keeps its measured word timings, so the reader can begin before the whole paragraph is ready. You can pause, go back to an earlier word, and continue at your own pace." }
        let clip = client.streaming ? try await verifyStream(client: client, text: text, voice: voice, directory: directory) : try await client.clip(text: text, voice: voice)
        guard await client.generationCount == 1 else { throw ReaderError.service("Speech did not exercise real HTTP generation") }
        let player = AudioPlayback()
        try player.load(clip); player.setSpeed(3)
        try await Task.sleep(for: .milliseconds(400))
        let start = player.position, wall = Date()
        try await Task.sleep(for: .milliseconds(800))
        let rate = (player.position - start) / Date().timeIntervalSince(wall)
        guard abs(rate - 3) < 0.5 else { throw ReaderError.service("Playback rate was \(rate)") }
        player.pause(); let paused = player.position
        try await Task.sleep(for: .milliseconds(200))
        guard abs(player.position - paused) < 0.02 else { throw ReaderError.service("Pause advanced audio") }
        let words = WordAlignment.locate(clip.words, in: text)
        guard let target = words.first(where: { chinese ? $0.range != nil : $0.word.word.lowercased() == "reader" }), target.range != nil else { throw ReaderError.audio }
        try player.seek(target.word.start, play: false)
        guard abs(player.position - target.word.start) < 0.03 else { throw ReaderError.service("Word seek missed") }
        player.resume()
        try await Task.sleep(for: .milliseconds(400))
        guard player.position > target.word.start + 0.4 else { throw ReaderError.service("Resume did not advance audio") }
        player.pause()
        let later = words[words.count / 2]
        try player.seek(later.word.start, play: false)
        guard abs(player.position - later.word.start) < 0.03 else { throw ReaderError.service("Forward word seek missed") }
        try player.seek(target.word.start, play: false)
        guard abs(player.position - target.word.start) < 0.03 else { throw ReaderError.service("Backward word seek missed") }
        let before = await client.generationCount
        _ = try await client.clip(text: text, voice: voice)
        guard await client.generationCount == before else { throw ReaderError.service("Cache regenerated speech") }
        let replay = try SpeechClient(configData: config, port: managed ? 4322 : 4318, cache: directory.appendingPathComponent(managed ? "Managed Cache" : "Cache"), streaming: client.streaming)
        _ = try await replay.clip(text: text, voice: voice)
        guard await replay.generationCount == 0 else { throw ReaderError.service("A new client did not reuse persisted audio") }
        player.stop()
        if let companion {
            await companion.shutDown()
            guard companion.process == nil else { throw ReaderError.service("Owned voice engine did not stop") }
            do { _ = try await client.health(); throw ReaderError.service("Owned endpoint stayed open") }
            catch let error as ReaderError { throw error }
            catch { }
            let original = try SpeechClient(configData: config, cache: directory.appendingPathComponent("Cache"))
            guard try await original.health().ready else { throw ReaderError.service("Original Qwen endpoint was interrupted") }
            print("PASS bundled Python/MLX engine, separate endpoint, startup, real generation, shutdown; original Qwen remains ready")
        }
        print("PASS real Qwen HTTP synthesis and alignment · \(clip.words.count) words")
        print("PASS native pitch-preserving playback measured \(String(format: "%.2f", rate))×")
        print("PASS nine fixed voices, pause/resume, forward/backward word seeks and persisted-cache replay without regeneration")
    }

    @MainActor static func verifyStream(client: SpeechClient, text: String, voice: Voice, directory: URL) async throws -> SpeechClip {
        let player = AudioPlayback()
        var ended = false, parts: [SpeechClip] = [], first = 0.0, paused = 0.0, playedBeforeEnd = false
        player.onEnd = { ended = true }
        player.setSpeed(3); player.begin()
        let started = Date()
        for try await part in await client.stream(text: text, voice: voice) {
            guard !ended else { throw ReaderError.service("Playback ended before the stream finished") }
            try player.append(part.clip); parts.append(part.clip)
            if parts.count == 1 {
                first = Date().timeIntervalSince(started)
                try await Task.sleep(for: .milliseconds(200))
                playedBeforeEnd = player.position > 0.05
                player.pause(); paused = player.position
            } else if parts.count == 2 {
                guard abs(player.position - paused) < 0.02 else { throw ReaderError.service("Appending streamed audio resumed a paused player") }
                try player.seek(0.1, play: false); player.resume()
            }
        }
        let complete = Date().timeIntervalSince(started)
        guard parts.count >= 2, first < complete, playedBeforeEnd else { throw ReaderError.service("Audio did not play before remaining generation finished") }
        player.finish()
        let clip = try SpeechClip.joining(parts)
        let deadline = Date().addingTimeInterval(clip.duration / 3 + 3)
        while !ended && Date() < deadline { try await Task.sleep(for: .milliseconds(50)) }
        guard ended, abs(player.position - clip.duration) < 0.03 else { throw ReaderError.service("Stream playback did not complete on its media clock") }
        player.stop()

        // Exercise a real underrun: a later piece must restart at the held media
        // position rather than skip forward by the wall-clock wait.
        ended = false; player.begin(); try player.append(parts[0])
        try await Task.sleep(for: .seconds(parts[0].duration / 3 + 0.3))
        guard !ended, abs(player.position - parts[0].duration) < 0.03 else { throw ReaderError.service("A temporary stream gap ended the reading") }
        try player.append(parts[1]); player.finish()
        try await Task.sleep(for: .milliseconds(250))
        guard player.position > parts[0].duration, player.position < parts[0].duration + 1.3 else { throw ReaderError.service("Buffered restart lost its media position") }
        player.stop()

        let report: [String: Any] = ["parts": parts.count, "firstAudioSeconds": first, "generationDoneSeconds": complete,
                                    "audioDuration": clip.duration, "playedBeforeGenerationDone": playedBeforeEnd,
                                    "pauseAppendSeekResume": true, "underrunRecovery": true]
        try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]).write(to: directory.appendingPathComponent("stream-\(voice.id).json"))
        print("PASS real audio stream · \(parts.count) pieces · first audio \(String(format: "%.2f", first))s · generation finished \(String(format: "%.2f", complete))s")
        print("PASS playback before generation ended, pause while receiving, seek/resume, and recovery from a stream gap")
        return clip
    }
}
