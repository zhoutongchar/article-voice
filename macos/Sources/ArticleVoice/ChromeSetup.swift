import AppKit
import Combine
import ArticleVoiceCore

struct ChromeConnection: Decodable {
    let host: String
    let extensionId: String
    let storeUrl: String?
    let port: Int
}
struct SetupProgress: Decodable {
    let stage: String
    let message: String
    let completed: Double?
    let total: Double?
}

@MainActor final class ChromeSetup: ObservableObject {
    @Published var installed: Bool
    @Published var busy = false
    @Published var voicesReady = false
    @Published var chromeStatus: ChromeConnectionStatus = .checking
    @Published var hasConnectedBefore = false
    @Published var message = "A natural voice for everything you read in Chrome."
    @Published var fraction: Double?
    @Published var bytes = ""
    @Published var error: String?
    @Published var showPreviewHelp = false
    let connection: ChromeConnection?
    let resources = Bundle.main.resourceURL!
    let directory = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Article Voice")
    private var child: Process?
    private var timer: Timer?
    private var pending = Data()
    private var runID = UUID()
    private var connectionMonitor = ChromeConnectionMonitor()
    private var wakeObserver: NSObjectProtocol?

    init() {
        let path = Bundle.main.bundleURL.standardizedFileURL.path
        let userApps = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Applications").path
        installed = path.hasPrefix("/Applications/") || path.hasPrefix(userApps + "/")
        connection = try? JSONDecoder().decode(ChromeConnection.self, from: Data(contentsOf: resources.appendingPathComponent("chrome/connection.json")))
        refreshConnection()
        timer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.refreshConnection() }
        }
        wakeObserver = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.refreshConnection(waking: true) }
        }
    }
    var chromeConnected: Bool { chromeStatus == .connected }
    var ready: Bool { installed && voicesReady && chromeConnected }
    var preview: Bool { connection?.storeUrl == nil }
    var chromeTitle: String {
        switch chromeStatus {
        case .connected: return "Chrome is connected"
        case .chromeClosed: return "Chrome is closed"
        case .checking: return "Checking Chrome…"
        case .disconnected: return hasConnectedBefore ? "Chrome needs reconnecting" : "Connect Chrome"
        }
    }
    var chromeDetail: String {
        switch chromeStatus {
        case .connected: return "Use the extension on any readable webpage."
        case .chromeClosed: return "Open Chrome to check your extension. Your voices stay installed."
        case .checking: return "Waiting for the extension to respond. This can take a few seconds."
        case .disconnected: return hasConnectedBefore
            ? "The extension isn’t responding. Enable or reinstall it to keep reading. Your voices are still ready."
            : "Add the Chrome extension. We’ll detect it automatically."
        }
    }
    var chromeAction: String {
        if chromeStatus == .chromeClosed { return "Open Chrome" }
        return hasConnectedBefore ? "Reconnect Chrome" : "Connect Chrome"
    }

    func install() {
        guard !busy else { return }
        busy = true; error = nil; message = "Installing Article Voice…"
        let source = Bundle.main.bundleURL
        let target = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Applications/Article Voice.app")
        Task {
            do {
                try await Task.detached {
                    let fm = FileManager.default
                    try fm.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
                    let temporary = target.deletingLastPathComponent().appendingPathComponent(".ArticleVoice-\(UUID().uuidString).app")
                    try fm.copyItem(at: source, to: temporary)
                    if fm.fileExists(atPath: target.path) {
                        guard Bundle(url: target)?.bundleIdentifier == "com.tong.articlevoice" else {
                            try? fm.removeItem(at: temporary)
                            throw NSError(domain: "ArticleVoice", code: 1, userInfo: [NSLocalizedDescriptionKey: "Another app already uses this name in Applications. Rename it, then try again."])
                        }
                        // Updating this app preserves a recoverable copy in Trash.
                        try fm.trashItem(at: target, resultingItemURL: nil)
                    }
                    do { try fm.moveItem(at: temporary, to: target) }
                    catch { try? fm.removeItem(at: temporary); throw error }
                }.value
                let options = NSWorkspace.OpenConfiguration()
                options.activates = true; options.createsNewApplicationInstance = true
                _ = try await NSWorkspace.shared.openApplication(at: target, configuration: options)
                NSApp.terminate(nil)
            } catch { busy = false; self.error = "Couldn’t install Article Voice: \(error.localizedDescription)" }
        }
    }

    func beginIfInstalled() { if installed { prepare() } }
    func prepare() {
        guard !busy else { return }
        guard connection != nil else { error = "This app is missing its Chrome connection. Download a fresh copy."; return }
        do {
            try registerChrome()
            busy = true; error = nil; fraction = nil; message = "Getting your voices ready…"
            let process = Process(), output = Pipe(), id = UUID()
            runID = id; pending = Data()
            process.executableURL = resources.appendingPathComponent("Python/bin/python3.12")
            process.arguments = ["-s", "-u", resources.appendingPathComponent("local/setup.py").path]
            var environment = ProcessInfo.processInfo.environment
            environment["PYTHONHOME"] = resources.appendingPathComponent("Python").path
            environment["PYTHONPATH"] = resources.appendingPathComponent("PythonPackages").path
            environment["PYTHONNOUSERSITE"] = "1"; environment["PYTHONDONTWRITEBYTECODE"] = "1"
            environment["TOKENIZERS_PARALLELISM"] = "false"
            process.environment = environment
            process.standardOutput = output
            FileManager.default.createFile(atPath: directory.appendingPathComponent("setup.log").path, contents: nil)
            process.standardError = try FileHandle(forWritingTo: directory.appendingPathComponent("setup.log"))
            output.fileHandleForReading.readabilityHandler = { [weak self] handle in
                let data = handle.availableData
                if data.isEmpty { handle.readabilityHandler = nil; return }
                Task { @MainActor in self?.consume(data, id: id) }
            }
            process.terminationHandler = { [weak self] process in
                Task { @MainActor in
                    guard let self, self.runID == id else { return }
                    self.busy = false; self.child = nil
                    if process.terminationStatus != 0 && self.error == nil {
                        self.error = "Setup paused. Click Resume to continue your download."
                    }
                }
            }
            try process.run(); child = process
        } catch { busy = false; self.error = error.localizedDescription }
    }

    private func consume(_ data: Data, id: UUID) {
        guard id == runID else { return }
        pending.append(data)
        while let end = pending.firstIndex(of: 10) {
            let line = pending.prefix(upTo: end)
            pending.removeSubrange(...end)
            guard let value = try? JSONDecoder().decode(SetupProgress.self, from: line) else { continue }
            message = value.message
            if let done = value.completed, let total = value.total, total > 0 {
                fraction = min(1, done / total)
                bytes = "\(ByteCountFormatter.string(fromByteCount: Int64(done), countStyle: .decimal)) of \(ByteCountFormatter.string(fromByteCount: Int64(total), countStyle: .decimal))"
            } else { fraction = nil; bytes = "" }
            if value.stage == "ready" { voicesReady = true; fraction = 1; bytes = "Available offline"; refreshConnection() }
            if value.stage == "error" { error = value.message }
        }
    }

    private func registerChrome() throws {
        guard let connection else { return }
        let fm = FileManager.default
        try fm.createDirectory(at: directory, withIntermediateDirectories: true)
        let folder = fm.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Google/Chrome/NativeMessagingHosts")
        try fm.createDirectory(at: folder, withIntermediateDirectories: true)
        let path = folder.appendingPathComponent(connection.host + ".json")
        let value: [String: Any] = ["name": connection.host, "description": "Article Voice local speech",
            "path": Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS/ArticleVoiceHost").path,
            "type": "stdio", "allowed_origins": ["chrome-extension://\(connection.extensionId)/"]]
        let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .prettyPrinted])
        if let existing = try? Data(contentsOf: path), existing != data {
            try existing.write(to: path.appendingPathExtension("previous"), options: .atomic)
        }
        try data.write(to: path, options: .atomic)
    }

    func refreshConnection(waking: Bool = false) {
        guard let connection else { chromeStatus = .disconnected; return }
        chromeStatus = connectionMonitor.update(
            receipt: try? Data(contentsOf: directory.appendingPathComponent("chrome-connection.json")),
            extensionId: connection.extensionId,
            chromeRunning: NSWorkspace.shared.runningApplications.contains { $0.bundleIdentifier == "com.google.Chrome" && !$0.isTerminated },
            now: Date().timeIntervalSince1970, waking: waking)
        hasConnectedBefore = connectionMonitor.hasConnectedBefore
    }
    func connectChrome() {
        if chromeStatus == .chromeClosed { launchChrome(); return }
        if let link = connection?.storeUrl, let url = URL(string: link) { openChrome(url) }
        else { showPreviewHelp.toggle() }
    }
    private func launchChrome() {
        guard let app = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.google.Chrome") else {
            error = "Install Google Chrome, then return here to connect it."; return
        }
        NSWorkspace.shared.openApplication(at: app, configuration: NSWorkspace.OpenConfiguration())
    }
    func openExtensions() { openChrome(URL(string: "chrome://extensions")!) }
    func revealExtension() { NSWorkspace.shared.activateFileViewerSelecting([resources.appendingPathComponent("ChromeExtension")]) }
    func tryReading() {
        guard let connection else { return }
        // The extension's welcome page confirms the live host connection and
        // opens the bundled story with its reader in one click.
        openChrome(URL(string: "chrome-extension://\(connection.extensionId)/welcome.html")!)
    }
    private func openChrome(_ url: URL) {
        guard let app = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.google.Chrome") else {
            error = "Install Google Chrome, then return here to connect it."; return
        }
        NSWorkspace.shared.open([url], withApplicationAt: app, configuration: NSWorkspace.OpenConfiguration())
    }
    func cancel() {
        runID = UUID()
        if let child, child.isRunning { child.terminate() }
        child = nil; busy = false
        if !voicesReady { message = "Download paused. Resume whenever you’re ready." }
    }
}
