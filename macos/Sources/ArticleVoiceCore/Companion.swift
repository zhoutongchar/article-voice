import Combine
import Foundation

@MainActor public final class Companion: ObservableObject {
    @Published public private(set) var ready = false
    @Published public private(set) var status = "Getting local voices ready…"
    public private(set) var process: Process?
    private var pipe: Pipe?
    private let client: SpeechClient
    private let resources: URL
    private let directory: URL
    private let port: Int
    private let instance = UUID().uuidString

    public init(client: SpeechClient, resources: URL, directory: URL, port: Int) {
        self.client = client; self.resources = resources; self.directory = directory; self.port = port
    }

    public func prepare() async throws -> [Voice] {
        try Task.checkCancellation()
        if let health = try? await client.health(), health.ready {
            guard !client.streaming || health.streaming == "aligned-sentences-v1" else { throw ReaderError.version }
            let voices = try await client.voices()
            try Task.checkCancellation()
            ready = true; status = "Local voices ready"
            return voices
        }
        // A responding incompatible service is not ours to stop or replace.
        do { _ = try await client.health() }
        catch ReaderError.version { throw ReaderError.version }
        catch { }
        try Task.checkCancellation()
        if process?.isRunning == false { process = nil }
        if process == nil {
            var upstream: Int?
            if client.streaming, port != 4318, let health = try? await client.health(at: 4318), health.ready { upstream = 4318 }
            try Task.checkCancellation()
            try prepareReferences()
            let python = resources.appendingPathComponent("Python/bin/python3.12")
            guard FileManager.default.isExecutableFile(atPath: python.path) else {
                throw ReaderError.service("The voice engine is missing. Reinstall Article Voice and try again.")
            }
            let child = Process(), output = Pipe()
            child.executableURL = python
            child.arguments = ["-s", "-u", resources.appendingPathComponent("local/server.py").path,
                               "--port", String(port), "--data-dir", directory.path, "--instance-token", instance]
            if let upstream { child.arguments! += ["--upstream-port", String(upstream)] }
            var environment = ProcessInfo.processInfo.environment
            environment["PYTHONHOME"] = resources.appendingPathComponent("Python").path
            environment["PYTHONPATH"] = resources.appendingPathComponent("PythonPackages").path
            environment["PYTHONNOUSERSITE"] = "1"
            environment["PYTHONDONTWRITEBYTECODE"] = "1"
            environment["HF_HUB_DISABLE_XET"] = "1"
            environment["TOKENIZERS_PARALLELISM"] = "false"
            child.environment = environment
            child.standardOutput = output; child.standardError = output
            let log = directory.appendingPathComponent("voice-engine.log")
            FileManager.default.createFile(atPath: log.path, contents: nil)
            let handle = try FileHandle(forWritingTo: log)
            output.fileHandleForReading.readabilityHandler = { input in
                let bytes = input.availableData
                if bytes.isEmpty { input.readabilityHandler = nil; try? handle.close(); return }
                try? handle.write(contentsOf: bytes)
            }
            try Task.checkCancellation()
            try child.run(); process = child; pipe = output
            status = upstream == nil ? "Preparing local voices · first setup may download about 3.6 GB" : "Connecting to local voices…"
        }
        for _ in 0..<2400 {
            try Task.checkCancellation()
            if process?.isRunning == false { process = nil; throw ReaderError.service("Local voices couldn’t start. Try again, or open the engine log in Settings.") }
            if let health = try? await client.health(), health.ready {
                guard health.instance == instance else { throw ReaderError.service("Another voice service is using this connection. Reopen Article Voice.") }
                guard !client.streaming || health.streaming == "aligned-sentences-v1" else { throw ReaderError.version }
                let voices = try await client.voices()
                try Task.checkCancellation()
                ready = true; status = "Local voices ready"
                return voices
            }
            try await Task.sleep(for: .milliseconds(500))
        }
        throw ReaderError.service("Voice setup is taking longer than expected. Check your connection and try again.")
    }

    private func prepareReferences() throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let source = resources.appendingPathComponent("VoiceReferences")
        let target = directory.appendingPathComponent("voice-references")
        try FileManager.default.createDirectory(at: target, withIntermediateDirectories: true)
        for entry in try FileManager.default.contentsOfDirectory(at: source, includingPropertiesForKeys: nil) {
            let destination = target.appendingPathComponent(entry.lastPathComponent)
            if !FileManager.default.fileExists(atPath: destination.path) {
                try FileManager.default.copyItem(at: entry, to: destination)
            }
        }
    }

    public func disconnected() { ready = false; status = "Local voices need to reconnect" }

    public func shutDown() async {
        guard let child = process, child.isRunning else { return }
        child.interrupt()
        for _ in 0..<50 {
            if !child.isRunning { process = nil; return }
            try? await Task.sleep(for: .milliseconds(100))
        }
        if child.isRunning { child.terminate() }
        for _ in 0..<20 {
            if !child.isRunning { process = nil; return }
            try? await Task.sleep(for: .milliseconds(100))
        }
        if !child.isRunning { process = nil }
    }
}
