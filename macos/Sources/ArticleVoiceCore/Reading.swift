import Foundation

public struct Passage: Equatable, Sendable {
    public let text: String
    public let range: NSRange
}

public struct ReadingPlan: Sendable {
    public let text: String
    public let passages: [Passage]
    public init(_ text: String, limit: Int = 450) {
        self.text = text
        var passages: [Passage] = []
        let original = text as NSString
        text.enumerateSubstrings(in: text.startIndex..<text.endIndex, options: .byParagraphs) { _, range, _, _ in
            var remaining = range
            while !remaining.isEmpty {
                let tail = text[remaining]
                var end = tail.index(tail.startIndex, offsetBy: min(limit, tail.count))
                if end < tail.endIndex,
                   let space = tail[..<end].lastIndex(where: { $0.isWhitespace || ".!?。！？".contains($0) }),
                   tail.distance(from: tail.startIndex, to: space) > limit / 2 {
                    end = tail.index(after: space)
                }
                let raw = NSRange(remaining.lowerBound..<end, in: text)
                let value = original.substring(with: raw)
                let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
                if !trimmed.isEmpty {
                    let offset = (value as NSString).range(of: trimmed).location
                    passages.append(Passage(text: trimmed, range: NSRange(location: raw.location + offset, length: (trimmed as NSString).length)))
                }
                remaining = end..<remaining.upperBound
            }
        }
        self.passages = passages
    }
}

public struct SpeechWord: Codable, Equatable, Sendable {
    public let word: String
    public let start: Double
    public let end: Double
    public init(word: String, start: Double, end: Double) { self.word = word; self.start = start; self.end = end }
}

public struct LocatedWord: Equatable, Sendable {
    public let word: SpeechWord
    public let range: NSRange?
    public init(word: SpeechWord, range: NSRange?) { self.word = word; self.range = range }
}

public enum WordAlignment {
    public static func locate(_ words: [SpeechWord], in text: String) -> [LocatedWord] {
        let source = text as NSString
        var cursor = 0
        return words.map { word in
            let needle = word.word.trimmingCharacters(in: .whitespacesAndNewlines)
            let found = source.range(of: needle, options: [.caseInsensitive, .diacriticInsensitive, .widthInsensitive],
                                     range: NSRange(location: cursor, length: source.length - cursor))
            let range: NSRange? = !needle.isEmpty && found.location != NSNotFound ? found : nil
            if let range { cursor = NSMaxRange(range) }
            return LocatedWord(word: word, range: range)
        }
    }

    // Hold the last word through breaths and punctuation, just as the web reader does.
    public static func current(_ words: [LocatedWord], at time: Double) -> LocatedWord? {
        words.last(where: { $0.word.start <= time })
    }
}

public struct Voice: Codable, Identifiable, Sendable {
    public let id: String
    public let name: String
    public let language: String
    public let description: String
    public let referenceId: String
}

public struct ModelConfiguration: Decodable, Sendable {
    public let model: String
    public let revision: String
    public let pipeline: String
}

public struct Health: Decodable, Sendable {
    public let ready: Bool
    public let model: String
    public let revision: String
    public let pipeline: String
    public let instance: String?
    public let streaming: String?
}

public struct SpeechChunk: Sendable {
    public let text: String
    public let offset: Int
    public let clip: SpeechClip
}

public struct SpeechClip: Codable, Sendable {
    public let pcm: Data
    public let duration: Double
    public let words: [SpeechWord]
    public let sampleRate: Int
    public let model: String
    public let revision: String
    public let pipeline: String
    public let referenceId: String

    public static func joining(_ clips: [SpeechClip]) throws -> SpeechClip {
        guard let first = clips.first, clips.reduce(0, { $0 + $1.pcm.count }) <= 16 * 1024 * 1024 else { throw ReaderError.audio }
        var pcm = Data(), words: [SpeechWord] = [], duration = 0.0
        for clip in clips {
            guard clip.model == first.model, clip.revision == first.revision, clip.pipeline == first.pipeline,
                  clip.referenceId == first.referenceId, clip.sampleRate == first.sampleRate else { throw ReaderError.version }
            pcm.append(clip.pcm)
            words += clip.words.map { SpeechWord(word: $0.word, start: $0.start + duration, end: $0.end + duration) }
            duration += clip.duration
        }
        return SpeechClip(pcm: pcm, duration: duration, words: words, sampleRate: first.sampleRate,
                          model: first.model, revision: first.revision, pipeline: first.pipeline, referenceId: first.referenceId)
    }

    public func validate(config: ModelConfiguration, reference: String) throws {
        guard model == config.model, revision == config.revision, pipeline == config.pipeline else { throw ReaderError.version }
        guard referenceId == reference, reference.count == 64 else { throw ReaderError.reference }
        guard sampleRate == 24000, !pcm.isEmpty, pcm.count % 2 == 0, pcm.count <= 16 * 1024 * 1024,
              duration.isFinite, abs(duration - Double(pcm.count) / 48000) < 0.01, !words.isEmpty else { throw ReaderError.audio }
        var previous = 0.0
        for word in words {
            guard word.start.isFinite, word.end.isFinite, word.start >= previous,
                  word.end >= word.start, word.end <= duration + 0.05 else { throw ReaderError.audio }
            previous = word.start
        }
    }
}

public enum ReaderError: LocalizedError {
    case version, reference, audio, unavailable, busy, service(String)
    public var errorDescription: String? {
        switch self {
        case .version: return "The local voice service needs an update. Quit and reopen Article Voice."
        case .reference: return "Your voice changed. Choose the voice again and retry."
        case .audio: return "This passage could not be read clearly. Try a shorter selection."
        case .unavailable: return "Local voices aren’t ready yet. Try again in a moment."
        case .busy: return "Another passage is being prepared. Please try again shortly."
        case .service(let message): return message
        }
    }
}
