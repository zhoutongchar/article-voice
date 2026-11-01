import ArticleVoiceCore
import Foundation
import AppKit

// A standalone runner keeps native checks usable with Command Line Tools; no
// full Xcode/XCTest installation is needed to build or verify the reader.
@main enum CoreChecks {
    static var count = 0
    static func require(_ condition: @autoclosure () -> Bool, _ message: String) throws {
        if !condition() { throw ReaderError.service(message) }
        count += 1
    }
    @MainActor static func main() throws {
        func heartbeat(_ time: Double, id: String = "official", version: Int? = 1) throws -> Data {
            var value: [String: Any] = ["extensionId": id, "connectedAt": time]
            if let version { value["protocolVersion"] = version }
            return try JSONSerialization.data(withJSONObject: value)
        }
        var connection = ChromeConnectionMonitor()
        let receipt = try heartbeat(1000)
        try require(connection.update(receipt: receipt, extensionId: "official", chromeRunning: true, now: 1000) == .connected, "Fresh heartbeat was not connected")
        try require(connection.update(receipt: receipt, extensionId: "official", chromeRunning: true, now: 1089) == .connected, "Heartbeat lease expired early")
        try require(connection.update(receipt: receipt, extensionId: "official", chromeRunning: true, now: 1090) == .disconnected, "Removed or disabled extension stayed connected indefinitely")
        try require(connection.hasConnectedBefore, "Lost reconnect history when heartbeat expired")
        let renewed = try heartbeat(1091)
        try require(connection.update(receipt: renewed, extensionId: "official", chromeRunning: true, now: 1091) == .connected, "Reinstalled extension did not reconnect")
        try require(connection.update(receipt: renewed, extensionId: "official", chromeRunning: false, now: 1092) == .chromeClosed, "Closing Chrome was treated as a removed extension")
        try require(connection.update(receipt: nil, extensionId: "official", chromeRunning: true, now: 1100) == .checking, "Chrome startup was not given time to respond")
        try require(connection.update(receipt: nil, extensionId: "official", chromeRunning: true, now: 1135) == .disconnected, "Startup check never finished")
        try require(connection.update(receipt: nil, extensionId: "official", chromeRunning: true, now: 5000, waking: true) == .checking, "Mac wake did not allow Chrome to resume")
        for bad in [try heartbeat(1000, version: nil), try heartbeat(1000, version: 2), try heartbeat(1000, id: "foreign"), try heartbeat(2000), Data("broken".utf8)] {
            var monitor = ChromeConnectionMonitor()
            _ = monitor.update(receipt: bad, extensionId: "official", chromeRunning: true, now: 1000)
            try require(monitor.update(receipt: bad, extensionId: "official", chromeRunning: true, now: 1035) == .disconnected, "Legacy, foreign, malformed or future receipt established liveness")
        }
        var legacy = ChromeConnectionMonitor()
        _ = legacy.update(receipt: try heartbeat(1000, version: nil), extensionId: "official", chromeRunning: true, now: 1000)
        try require(legacy.hasConnectedBefore, "Legacy installation lost reconnect instructions")
        // Use a private board: these checks never touch the user's clipboard.
        let board = NSPasteboard.withUniqueName()
        defer { board.releaseGlobally() }
        let original = NSPasteboardItem()
        original.setString("Original café 😀", forType: .string)
        original.setData(Data("<b>Original</b>".utf8), forType: .html)
        board.writeObjects([original])
        let snapshot = ClipboardSnapshot(board)!
        board.clearContents(); board.setString("Temporary copied selection", forType: .string)
        try require(snapshot.restore(board, replacing: board.changeCount), "Could not restore owned clipboard contents")
        try require(board.string(forType: .string) == "Original café 😀" && board.data(forType: .html) == Data("<b>Original</b>".utf8), "Clipboard restoration lost text or rich formats")
        let staleCount = board.changeCount
        board.clearContents(); board.setString("A later user copy", forType: .string)
        try require(!snapshot.restore(board, replacing: staleCount) && board.string(forType: .string) == "A later user copy", "Clipboard cleanup overwrote a later copy")
        board.clearContents()
        let empty = ClipboardSnapshot(board)!
        board.setString("Temporary", forType: .string)
        try require(empty.restore(board, replacing: board.changeCount) && (board.pasteboardItems ?? []).isEmpty, "Empty clipboard was not restored")
        let text = "  A café 😀 with quiet corners.\n\n" + String(repeating: "Another sentence to read. ", count: 50) + "\n中文也可以朗读。"
        let plan = ReadingPlan(text)
        try require(plan.passages.count > 3, "Long reading was not split")
        for passage in plan.passages {
            try require((text as NSString).substring(with: passage.range) == passage.text, "Passage lost its source coordinates")
            try require(passage.text.count <= 450, "Passage exceeded generation budget")
        }
        let source = "😀 A café, then quiet. 中文朗读。"
        let words = ["A", "cafe", "unknown", "quiet", "中文", "朗读"].enumerated().map { SpeechWord(word: $0.element, start: Double($0.offset), end: Double($0.offset) + 0.5) }
        let mapped = WordAlignment.locate(words, in: source)
        try require(mapped[0].range?.location == 3, "Emoji shifted UTF16 offsets")
        try require(mapped[2].range == nil, "Unknown word invented coordinates")
        try require((source as NSString).substring(with: mapped[3].range!) == "quiet", "Unknown word lost later alignment")
        try require((source as NSString).substring(with: mapped[4].range!) == "中文", "Chinese alignment failed")
        let timed = [SpeechWord(word: "first", start: 0.2, end: 0.5), SpeechWord(word: "next", start: 1.5, end: 2)]
        let located = WordAlignment.locate(timed, in: "first next")
        try require(WordAlignment.current(located, at: 0.1) == nil, "Highlighted before speech")
        try require(WordAlignment.current(located, at: 1.2)?.word.word == "first", "Highlight flashed during breath")
        try require(WordAlignment.current(located, at: 1.5)?.word.word == "next", "Highlight missed next word")
        try require(ReadingPlan(" \n\n").passages.isEmpty, "Empty reading had passages")
        try require(ReadingPlan(String(repeating: "界", count: 1200)).passages.map { $0.text.count } == [450,450,300], "Unbroken text was not bounded")

        let config = try JSONDecoder().decode(ModelConfiguration.self, from: Data(#"{"model":"pinned","revision":"commit","pipeline":"fixed-reference"}"#.utf8))
        let reference = String(repeating: "a", count: 64)
        let valid: [String: Any] = ["pcm": Data(repeating: 1, count: 48000).base64EncodedString(), "duration": 1.0,
                                  "sampleRate": 24000, "model": "pinned", "revision": "commit", "pipeline": "fixed-reference", "referenceId": reference,
                                  "words": [["word":"hello","start":0.1,"end":0.8]]]
        func clip(_ object: [String: Any]) throws -> SpeechClip { try JSONDecoder().decode(SpeechClip.self, from: JSONSerialization.data(withJSONObject: object)) }
        try clip(valid).validate(config: config, reference: reference)
        let joined = try SpeechClip.joining([clip(valid), clip(valid)])
        try joined.validate(config: config, reference: reference)
        try require(joined.pcm.count == 96000 && joined.duration == 2, "Stream pieces lost their PCM duration")
        try require(joined.words[1].start == 1.1 && joined.words[1].end == 1.8, "Stream word times lost the preceding audio offset")
        let joinedWords = WordAlignment.locate(joined.words, in: "hello hello")
        try require(joinedWords[1].range?.location == 6, "Repeated words lost their source position across streamed pieces")
        try require(WordAlignment.current(joinedWords, at: 1)?.range?.location == 0, "Highlight flashed between streamed pieces")
        for changes: [String: Any] in [["revision":"stale"], ["referenceId":String(repeating:"b", count:64)], ["duration":7], ["pcm":""], ["words":[["word":"hello","start":0.8,"end":0.1]]]] {
            do { try clip(valid.merging(changes) { _, new in new }).validate(config: config, reference: reference); throw ReaderError.service("Accepted invalid audio") }
            catch ReaderError.audio, ReaderError.version, ReaderError.reference { count += 1 }
        }
        print("PASS \(count) native checks: Chrome connection expiry/recovery, source coordinates, bounded passages, Unicode/CJK, word holds, audio identity and timestamps")
    }
}
