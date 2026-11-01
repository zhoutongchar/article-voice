import CryptoKit
import Foundation

public actor SpeechClient {
    public let config: ModelConfiguration
    public nonisolated let streaming: Bool
    private let configDigest: String
    private let baseURL: URL
    private let cache: URL
    private let session: URLSession
    public private(set) var generationCount = 0
    public private(set) var cacheHits = 0

    public init(configData: Data, port: Int = 4318, cache: URL, streaming: Bool = false) throws {
        config = try JSONDecoder().decode(ModelConfiguration.self, from: configData)
        configDigest = Self.digest(configData)
        baseURL = URL(string: "http://127.0.0.1:\(port)")!
        self.cache = cache
        self.streaming = streaming
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 180
        configuration.timeoutIntervalForResource = 240
        session = URLSession(configuration: configuration)
    }

    public nonisolated static func digest(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }

    public func health(at port: Int? = nil) async throws -> Health {
        let target = port.map { URL(string: "http://127.0.0.1:\($0)")! } ?? baseURL
        var request = URLRequest(url: target.appendingPathComponent("health"))
        request.timeoutInterval = 2
        let (data, response) = try await session.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw ReaderError.unavailable }
        let health = try JSONDecoder().decode(Health.self, from: data)
        guard health.model == config.model, health.revision == config.revision, health.pipeline == config.pipeline else { throw ReaderError.version }
        return health
    }

    public func voices() async throws -> [Voice] {
        let (data, response) = try await session.data(from: baseURL.appendingPathComponent("voices"))
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw ReaderError.unavailable }
        struct Catalog: Decodable { let voices: [Voice]; let model: String; let revision: String; let pipeline: String }
        let value = try JSONDecoder().decode(Catalog.self, from: data)
        guard value.model == config.model, value.revision == config.revision, value.pipeline == config.pipeline else { throw ReaderError.version }
        guard !value.voices.isEmpty, value.voices.allSatisfy({ $0.referenceId.count == 64 && $0.referenceId.allSatisfy { $0.isHexDigit && !$0.isUppercase } }) else { throw ReaderError.reference }
        return value.voices
    }

    public func clip(text: String, voice: Voice, language: String = "") async throws -> SpeechClip {
        try Task.checkCancellation()
        if streaming {
            var clips: [SpeechClip] = []
            for try await chunk in stream(text: text, voice: voice, language: language) { clips.append(chunk.clip) }
            // A cancelled AsyncThrowingStream consumer can finish its loop
            // normally; cancellation must not become an empty-audio error.
            try Task.checkCancellation()
            return try SpeechClip.joining(clips)
        }
        let file = try cacheFile(text: text, voice: voice, language: language)
        if let clip = cached(file, voice: voice) { return clip }
        var request = try speechRequest(path: "speech", text: text, voice: voice, language: language)
        request.timeoutInterval = 180
        generationCount += 1
        let (data, response) = try await session.data(for: request)
        try checkStatus(response)
        try Task.checkCancellation()
        let clip = try JSONDecoder().decode(SpeechClip.self, from: data)
        try clip.validate(config: config, reference: voice.referenceId)
        save(clip, at: file)
        return clip
    }

    private func cacheFile(text: String, voice: Voice, language: String) throws -> URL {
        let identity = try JSONEncoder().encode([configDigest] + (streaming ? ["aligned-paragraphs-v1"] : []) + [voice.id, voice.referenceId, language, text])
        return cache.appendingPathComponent(Self.digest(identity)).appendingPathExtension("json")
    }

    private func cached(_ file: URL, voice: Voice) -> SpeechClip? {
        if let data = try? Data(contentsOf: file), let clip = try? JSONDecoder().decode(SpeechClip.self, from: data),
           (try? clip.validate(config: config, reference: voice.referenceId)) != nil {
            cacheHits += 1
            try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: file.path)
            return clip
        }
        return nil
    }

    private func speechRequest(path: String, text: String, voice: Voice, language: String) throws -> URLRequest {
        var request = URLRequest(url: baseURL.appendingPathComponent(path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["text": text, "voice": voice.id, "language": language, "referenceId": voice.referenceId])
        return request
    }

    private func checkStatus(_ response: URLResponse) throws {
        let status = (response as? HTTPURLResponse)?.statusCode
        guard status == 200 else {
            if status == 409 { throw ReaderError.reference }
            if status == 429 { throw ReaderError.busy }
            throw ReaderError.audio
        }
    }

    private func save(_ clip: SpeechClip, at file: URL) {
        try? FileManager.default.createDirectory(at: cache, withIntermediateDirectories: true)
        if let data = try? JSONEncoder().encode(clip) { try? data.write(to: file, options: .atomic) }
        trimCache()
    }

    public func stream(text: String, voice: Voice, language: String = "") -> AsyncThrowingStream<SpeechChunk, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    try await receive(text: text, voice: voice, language: language) { continuation.yield($0) }
                    continuation.finish()
                } catch { continuation.finish(throwing: error) }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    private func receive(text: String, voice: Voice, language: String, emit: (SpeechChunk) -> Void) async throws {
        try Task.checkCancellation()
        let file = try cacheFile(text: text, voice: voice, language: language)
        if let clip = cached(file, voice: voice) { emit(SpeechChunk(text: text, offset: 0, clip: clip)); return }
        struct Event: Decodable {
            let type: String; let protocolVersion: String?; let text: String?; let offset: Int?; let clip: SpeechClip?; let error: String?
            enum CodingKeys: String, CodingKey { case type, text, offset, clip, error; case protocolVersion = "protocol" }
        }
        let request = try speechRequest(path: "speech/stream", text: text, voice: voice, language: language)
        generationCount += 1
        let (bytes, response) = try await session.bytes(for: request)
        try checkStatus(response)
        let source = text as NSString
        var clips: [SpeechClip] = [], end = 0, pcmBytes = 0, started = false, finished = false
        for try await line in bytes.lines {
            try Task.checkCancellation()
            guard line.utf8.count <= 24 * 1024 * 1024 else { throw ReaderError.audio }
            let event = try JSONDecoder().decode(Event.self, from: Data(line.utf8))
            switch event.type {
            case "start":
                guard !started, event.protocolVersion == "aligned-paragraphs-v1" else { throw ReaderError.version }
                started = true
            case "clip":
                guard started, !finished, let value = event.text, !value.isEmpty, let offset = event.offset, let clip = event.clip,
                      offset >= end, offset <= source.length, (value as NSString).length <= source.length - offset,
                      source.substring(with: NSRange(location: end, length: offset - end)).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                      source.substring(with: NSRange(location: offset, length: (value as NSString).length)) == value else { throw ReaderError.audio }
                try clip.validate(config: config, reference: voice.referenceId)
                pcmBytes += clip.pcm.count
                guard pcmBytes <= 16 * 1024 * 1024 else { throw ReaderError.audio }
                end = offset + (value as NSString).length; clips.append(clip)
                emit(SpeechChunk(text: value, offset: offset, clip: clip))
            case "done":
                guard started, !clips.isEmpty, !finished,
                      source.substring(from: end).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw ReaderError.audio }
                finished = true
            case "error": throw ReaderError.service(event.error ?? "This reading stopped. Try again.")
            default: throw ReaderError.version
            }
        }
        try Task.checkCancellation()
        guard finished else { throw ReaderError.service("The audio connection ended early. Try this reading again.") }
        let combined = try SpeechClip.joining(clips)
        try combined.validate(config: config, reference: voice.referenceId)
        save(combined, at: file)
    }

    public func clearCache() throws {
        guard FileManager.default.fileExists(atPath: cache.path) else { return }
        for file in try FileManager.default.contentsOfDirectory(at: cache, includingPropertiesForKeys: nil) where file.pathExtension == "json" {
            try FileManager.default.removeItem(at: file)
        }
    }

    private func trimCache() {
        let keys: Set<URLResourceKey> = [.contentModificationDateKey, .fileSizeKey]
        let files = (try? FileManager.default.contentsOfDirectory(at: cache, includingPropertiesForKeys: Array(keys))) ?? []
        let entries = files.filter { $0.pathExtension == "json" }.compactMap { url -> (URL, Date, Int)? in
            guard let values = try? url.resourceValues(forKeys: keys) else { return nil }
            return (url, values.contentModificationDate ?? .distantPast, values.fileSize ?? 0)
        }.sorted { $0.1 < $1.1 }
        var total = entries.reduce(0) { $0 + $1.2 }
        for (file, _, bytes) in entries where total > 128 * 1024 * 1024 {
            if (try? FileManager.default.removeItem(at: file)) != nil { total -= bytes }
        }
    }
}
