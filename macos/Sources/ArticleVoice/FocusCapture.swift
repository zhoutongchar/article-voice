import AppKit
import ApplicationServices

private enum AXText {
    static let controlRoles: Set<String> = [kAXWindowRole, kAXButtonRole, kAXRadioButtonRole, kAXCheckBoxRole, kAXPopUpButtonRole, kAXSliderRole, kAXProgressIndicatorRole, kAXScrollBarRole, kAXMenuRole, kAXMenuItemRole, kAXMenuBarRole]
    static func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
        var value: CFTypeRef?
        return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
    }
    static func parameter(_ element: AXUIElement, _ name: String, _ input: CFTypeRef) -> CFTypeRef? {
        var value: CFTypeRef?
        return AXUIElementCopyParameterizedAttributeValue(element, name as CFString, input, &value) == .success ? value : nil
    }
    static func element(_ value: CFTypeRef?) -> AXUIElement? {
        guard let value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
        return (value as! AXUIElement)
    }
    static func range(_ value: CFTypeRef?) -> CFRange? {
        guard let value, CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
        var result = CFRange()
        return AXValueGetValue(value as! AXValue, .cfRange, &result) ? result : nil
    }
    static func rect(_ value: CFTypeRef?) -> CGRect? {
        guard let value, CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
        var result = CGRect.zero
        return AXValueGetValue(value as! AXValue, .cgRect, &result) ? result : nil
    }
    static func markerRange(_ value: CFTypeRef?) -> AXTextMarkerRange? {
        guard let value, CFGetTypeID(value) == AXTextMarkerRangeGetTypeID() else { return nil }
        return (value as! AXTextMarkerRange)
    }
    static func marker(_ value: CFTypeRef?) -> AXTextMarker? {
        guard let value, CFGetTypeID(value) == AXTextMarkerGetTypeID() else { return nil }
        return (value as! AXTextMarker)
    }
    static func webOwner(_ element: AXUIElement) -> AXUIElement? {
        var current = element
        for _ in 0..<20 {
            if attribute(current, kAXRoleAttribute) as? String == "AXWebArea" { return current }
            guard let parent = self.element(attribute(current, kAXParentAttribute)) else { return nil }
            current = parent
        }
        return nil
    }
}

// AX references are used only for read-only queries. The one mutable marker
// cache owns its lock, so source snapshots can cross the capture/bounds queues.
enum SourceAnchor: @unchecked Sendable {
    case indexed(AXUIElement, Int)
    case marked(WebTextAnchor)

    // Browser marker indexes are not offsets in the expanded selection string.
    // Keep the selected marker itself and advance through the browser's text.
    static func web(_ owner: AXUIElement, range: AXTextMarkerRange, text: String) -> SourceAnchor? {
        guard !text.isEmpty else { return nil }
        return .marked(WebTextAnchor(owner: owner, start: AXTextMarkerRangeCopyStartMarker(range), text: text))
    }

    func bounds(for range: NSRange, expected: String) -> CGRect? {
        let element: AXUIElement, input: CFTypeRef, stringAttribute: String, boundsAttribute: String
        switch self {
        case .indexed(let owner, let offset):
            element = owner
            var value = CFRange(location: offset + range.location, length: range.length)
            guard let parameter = AXValueCreate(.cfRange, &value) else { return nil }
            input = parameter; stringAttribute = kAXStringForRangeParameterizedAttribute
            boundsAttribute = kAXBoundsForRangeParameterizedAttribute
        case .marked(let anchor):
            element = anchor.owner
            guard let start = anchor.marker(at: range.location), let end = anchor.marker(at: NSMaxRange(range)) else { return nil }
            input = AXTextMarkerRangeCreate(nil, start, end)
            stringAttribute = kAXStringForTextMarkerRangeParameterizedAttribute
            boundsAttribute = kAXBoundsForTextMarkerRangeParameterizedAttribute
        }
        guard AXText.parameter(element, stringAttribute, input) as? String == expected else { return nil }
        return AXText.rect(AXText.parameter(element, boundsAttribute, input))
    }
}

final class WebTextAnchor: @unchecked Sendable {
    let owner: AXUIElement
    private let text: NSString
    private var markers: [Int: AXTextMarker]
    private let lock = NSLock()

    init(owner: AXUIElement, start: AXTextMarker, text: String) {
        self.owner = owner; self.text = text as NSString; markers = [0: start]
    }

    func marker(at requested: Int) -> AXTextMarker? {
        lock.lock(); defer { lock.unlock() }
        guard requested >= 0, requested <= text.length else { return nil }
        if let marker = markers[requested] { return marker }
        guard var offset = markers.keys.filter({ $0 < requested }).max(), var current = markers[offset] else { return nil }
        // Most steps cover a whole word. Character steps handle an offset
        // inside a word, inline node boundaries and punctuation precisely.
        var steps = 0
        let limit = (requested - offset + 64) * 3
        while offset < requested, steps < limit {
            steps += 1
            var chosen: (AXTextMarker, Int)?
            for attribute in [kAXNextWordEndTextMarkerForTextMarkerParameterizedAttribute, kAXNextTextMarkerForTextMarkerParameterizedAttribute] {
                guard let next = AXText.marker(AXText.parameter(owner, attribute, current)) else { continue }
                let range = AXTextMarkerRangeCreate(nil, current, next)
                guard let value = AXText.parameter(owner, kAXStringForTextMarkerRangeParameterizedAttribute, range) as? String else { continue }
                let length = (value as NSString).length
                guard offset + length <= requested,
                      text.substring(with: NSRange(location: offset, length: length)) == value else { continue }
                if length == 0, attribute != kAXNextTextMarkerForTextMarkerParameterizedAttribute { continue }
                chosen = (next, length); break
            }
            guard let (next, length) = chosen else { return nil }
            current = next; offset += length; markers[offset] = current
        }
        return offset == requested ? current : nil
    }
}

struct SourceSpan: Sendable {
    let range: NSRange
    let anchor: SourceAnchor
}

struct CapturedText: Sendable {
    let text: String
    let source: String
    var spans: [SourceSpan] = []
    var pid: pid_t? = nil

    func bounds(for range: NSRange) -> CGRect? {
        guard NSMaxRange(range) <= (text as NSString).length,
              let span = spans.first(where: { $0.range.location <= range.location && NSMaxRange(range) <= NSMaxRange($0.range) }) else { return nil }
        return span.anchor.bounds(for: NSRange(location: range.location - span.range.location, length: range.length),
                                  expected: (text as NSString).substring(with: range))
    }
}

enum CaptureError: LocalizedError {
    case permission, empty(String), tooLong, secure
    var errorDescription: String? {
        switch self {
        case .permission: return "Enable Accessibility to read from another app, or use its Services → Read with Article Voice menu."
        case .empty(let app): return "No readable text was found in \(app). Select a passage, or paste text here."
        case .tooLong: return "Choose a shorter selection—up to 20,000 characters at a time."
        case .secure: return "Focus text outside the password field to read it."
        }
    }
}

private enum CaptureAttempt: Sendable {
    case selection(CapturedText), area(CapturedText), empty, tooLong
}

@MainActor final class FocusCapture: ObservableObject {
    @Published private(set) var trusted = AXIsProcessTrusted()
    private var previous: NSRunningApplication?
    private var observer: NSObjectProtocol?
    private var requestedAccessibility: [pid_t: Date] = [:]

    init() {
        previous = NSWorkspace.shared.frontmostApplication
        observer = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { [weak self] notification in
            MainActor.assumeIsolated {
                guard let app = notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication,
                      app.processIdentifier != ProcessInfo.processInfo.processIdentifier else { return }
                self?.previous = app
            }
        }
    }
    func refreshPermission() { trusted = AXIsProcessTrusted() }
    var availableApplications: [NSRunningApplication] {
        NSWorkspace.shared.runningApplications.filter {
            $0.activationPolicy == .regular && $0.processIdentifier != ProcessInfo.processInfo.processIdentifier
        }.sorted { ($0.localizedName ?? "").localizedCaseInsensitiveCompare($1.localizedName ?? "") == .orderedAscending }
    }
    func requestPermission() {
        let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
        trusted = AXIsProcessTrustedWithOptions([key: true] as CFDictionary)
        if !trusted, let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility") { NSWorkspace.shared.open(url) }
    }

    func read(focusedArea: Bool = false, from selectedApp: NSRunningApplication? = nil, allowCopy: Bool = true) async throws -> CapturedText {
        refreshPermission()
        guard trusted else { throw CaptureError.permission }
        let active = NSWorkspace.shared.frontmostApplication
        guard let app = selectedApp ?? (active?.processIdentifier == ProcessInfo.processInfo.processIdentifier ? previous : active) else { throw CaptureError.empty("the active app") }
        if !app.isActive, let url = app.bundleURL {
            NSApp.yieldActivation(to: app)
            let configuration = NSWorkspace.OpenConfiguration()
            configuration.activates = true
            _ = try await NSWorkspace.shared.openApplication(at: url, configuration: configuration)
        }
        let pid = app.processIdentifier, name = app.localizedName ?? "Selected text"
        let electron = app.bundleURL.map { FileManager.default.fileExists(atPath: $0.appendingPathComponent("Contents/Frameworks/Electron Framework.framework").path) } ?? false
        let enableAccessibility = electron && (app.launchDate == nil || requestedAccessibility[pid] != app.launchDate)
        let diagnostics = appDataDirectory().appendingPathComponent("capture-diagnostics.json")
        let result = try await Task.detached(priority: .userInitiated) { () async throws -> CaptureAttempt in
            // One bounded structural report, without source text, helps
            // distinguish missing accessibility content from a capture bug.
            var trace: [[String: Any]] = []
            defer {
                if let data = try? JSONSerialization.data(withJSONObject: ["app": name, "electron": electron, "steps": trace], options: [.prettyPrinted, .sortedKeys]) {
                    try? data.write(to: diagnostics, options: .atomic)
                }
            }
            let application = AXUIElementCreateApplication(pid)
            AXUIElementSetMessagingTimeout(application, 0.2)
            if enableAccessibility {
                // Electron's documented request exposes the web accessibility
                // tree for this process; it does not change the app's settings.
                let result = AXUIElementSetAttributeValue(application, "AXManualAccessibility" as CFString, kCFBooleanTrue)
                trace.append(["attribute": "AXManualAccessibility", "result": result.rawValue])
                try await Task.sleep(for: .milliseconds(250))
            }
            let focused = AXText.element(AXText.attribute(application, kAXFocusedUIElementAttribute))
            let window = AXText.element(AXText.attribute(application, kAXFocusedWindowAttribute))
                ?? AXText.element(AXText.attribute(application, kAXMainWindowAttribute))
            let root = focused ?? window
            guard let root else { return .empty }
            let titleElement = window.flatMap { AXText.element(AXText.attribute($0, kAXTitleUIElementAttribute)) }
            func captured(_ text: String, anchor: SourceAnchor?) -> CapturedText {
                return CapturedText(text: text, source: name, spans: anchor.map { [SourceSpan(range: NSRange(location: 0, length: (text as NSString).length), anchor: $0)] } ?? [], pid: pid)
            }
            func selectedText(_ text: String, anchor: SourceAnchor?) throws -> CaptureAttempt {
                guard text.count <= 20000 else { throw CaptureError.tooLong }
                return .selection(captured(text, anchor: anchor))
            }
            func area(_ text: String, anchor: SourceAnchor?) -> CaptureAttempt {
                text.count <= 20000 ? .area(captured(text, anchor: anchor)) : .tooLong
            }
            if AXText.attribute(root, kAXSubroleAttribute) as? String == kAXSecureTextFieldSubrole { throw CaptureError.secure }
            let rootRole = AXText.attribute(root, kAXRoleAttribute) as? String
            // An inaccessible editor often exposes an empty hidden input.
            // Its surrounding application UI is not the requested document.
            if [kAXTextAreaRole, kAXTextFieldRole].contains(rootRole ?? ""),
               (AXText.attribute(root, kAXValueAttribute) as? String ?? "").isEmpty { return .empty }
            let deadline = Date().addingTimeInterval(2)
            let focusedWeb = AXText.webOwner(root)
            if !focusedArea, let web = focusedWeb,
               let range = AXText.markerRange(AXText.attribute(web, kAXSelectedTextMarkerRangeAttribute)),
               let value = AXText.parameter(web, kAXStringForTextMarkerRangeParameterizedAttribute, range) as? String,
               !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                return try selectedText(value, anchor: SourceAnchor.web(web, range: range, text: value))
            }
            // Each fallback owns its text. A readable focused subtree wins;
            // window toolbars are never appended to that successful capture.
            let scopes = [root, focusedWeb, window].compactMap { $0 }
            var visited = 0, seen: [AXUIElement] = []
            for scope in scopes {
                var stack = [scope], combined = "", spans: [SourceSpan] = []
                while let element = stack.popLast(), visited < 400, Date() < deadline {
                    if seen.contains(where: { CFEqual($0, element) }) { continue }
                    seen.append(element)
                    try Task.checkCancellation(); visited += 1
                    if let titleElement, CFEqual(titleElement, element) { continue }
                    if AXText.attribute(element, kAXSubroleAttribute) as? String == kAXSecureTextFieldSubrole { continue }
                    let role = AXText.attribute(element, kAXRoleAttribute) as? String
                    let value = AXText.attribute(element, kAXValueAttribute) as? String
                    trace.append(["role": role ?? "unknown", "valueLength": value.map { ($0 as NSString).length } ?? 0])
                    if !focusedArea, role == "AXWebArea",
                       let selectedRange = AXText.markerRange(AXText.attribute(element, kAXSelectedTextMarkerRangeAttribute)),
                       let selection = AXText.parameter(element, kAXStringForTextMarkerRangeParameterizedAttribute, selectedRange) as? String,
                       !selection.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        return try selectedText(selection, anchor: SourceAnchor.web(element, range: selectedRange, text: selection))
                    }
                    if !focusedArea, let selection = AXText.attribute(element, kAXSelectedTextAttribute) as? String,
                       !selection.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        if let range = AXText.range(AXText.attribute(element, kAXSelectedTextRangeAttribute)), range.location >= 0,
                            range.length == (selection as NSString).length { return try selectedText(selection, anchor: .indexed(element, range.location)) }
                        return try selectedText(selection, anchor: nil)
                    }
                    if role == "AXWebArea", !focusedArea { return .empty }
                    if role == "AXWebArea",
                       let fullRange = AXText.markerRange(AXText.parameter(element, kAXTextMarkerRangeForUIElementParameterizedAttribute, element)),
                       let value = AXText.parameter(element, kAXStringForTextMarkerRangeParameterizedAttribute, fullRange) as? String, !value.isEmpty,
                       let anchor = SourceAnchor.web(element, range: fullRange, text: value) { return area(value, anchor: anchor) }
                    if !AXText.controlRoles.contains(role ?? ""), let value,
                       !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        if CFEqual(element, scope) { return area(value, anchor: .indexed(element, 0)) }
                        if !combined.isEmpty { combined += "\n\n" }
                        let start = (combined as NSString).length
                        combined += value
                        guard combined.count <= 20000 else { return .tooLong }
                        spans.append(SourceSpan(range: NSRange(location: start, length: (value as NSString).length), anchor: .indexed(element, 0)))
                        continue
                    }
                    if let children = AXText.attribute(element, kAXChildrenAttribute) as? [AXUIElement] {
                        stack.append(contentsOf: children.prefix(400 - visited).reversed())
                    }
                }
                if !combined.isEmpty { return .area(CapturedText(text: combined, source: name, spans: spans, pid: pid)) }
            }
            return .empty
        }.value
        switch result {
        case .selection(let text), .area(let text):
            if enableAccessibility, let launch = app.launchDate { requestedAccessibility[pid] = launch }
            return text
        case .empty, .tooLong: break
        }
        if !focusedArea, allowCopy, let text = try await SelectionCopy.read(from: pid) {
            guard text.count <= 20000 else { throw CaptureError.tooLong }
            return CapturedText(text: text, source: name, pid: pid)
        }
        if case .tooLong = result { throw CaptureError.tooLong }
        throw CaptureError.empty(name)
    }
}

@MainActor final class SourceHighlight: ObservableObject {
    @Published private(set) var note: String?
    private let panel: NSPanel
    private var observer: NSObjectProtocol?
    private var request: (NSRange, CapturedText)?
    private let boundsQueue = DispatchQueue(label: "ArticleVoice.source-bounds", qos: .userInitiated)
    private var resolving = false
    private var revision = UUID()
    init() {
        panel = NSPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.title = "Article Voice spoken word"
        panel.level = .floating; panel.isOpaque = false; panel.backgroundColor = .clear
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        panel.ignoresMouseEvents = true; panel.hasShadow = false
        let view = NSView(); view.wantsLayer = true; view.layer?.cornerRadius = 3
        view.layer?.backgroundColor = NSColor.systemYellow.withAlphaComponent(0.5).cgColor
        view.layer?.borderWidth = 1; view.layer?.borderColor = NSColor.systemOrange.withAlphaComponent(0.7).cgColor
        panel.contentView = view
        observer = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.revision = UUID(); self?.update() }
        }
    }
    func hide() { revision = UUID(); request = nil; panel.orderOut(nil); note = nil }
    func show(_ range: NSRange?, source: CapturedText?) {
        guard let range, let source else { hide(); return }
        revision = UUID(); request = (range, source); update()
    }
    private func update() {
        guard let (range, source) = request, let pid = source.pid else { panel.orderOut(nil); note = nil; return }
        guard !source.spans.isEmpty else { panel.orderOut(nil); note = "This source shares text but not word positions. Follow the text here."; return }
        let foreground = NSWorkspace.shared.frontmostApplication?.processIdentifier
        guard foreground == pid || foreground == ProcessInfo.processInfo.processIdentifier else { panel.orderOut(nil); note = nil; return }
        guard !resolving else { return }
        resolving = true
        let ticket = revision
        boundsQueue.async {
            let rect = source.bounds(for: range)
            Task { @MainActor in
                self.resolving = false
                guard self.revision == ticket else { self.update(); return }
                self.place(rect, source: source)
            }
        }
    }
    private func place(_ rect: CGRect?, source: CapturedText) {
        guard let rect, !rect.isNull, rect.width > 0, rect.height > 0, rect.height < 150 else {
            panel.orderOut(nil); note = "Word positions aren’t available here. Follow the text in the player."; return
        }
        let top = NSScreen.screens.first?.frame.maxY ?? 0
        let converted = CGRect(x: rect.minX - 2, y: top - rect.maxY - 1, width: rect.width + 4, height: rect.height + 2)
        guard NSScreen.screens.contains(where: { $0.frame.intersects(converted) }) else { panel.orderOut(nil); note = "Scroll the source to the spoken passage to see its word marker."; return }
        guard !NSApp.windows.contains(where: { $0 !== panel && $0.isVisible && $0.frame.intersects(converted) }) else {
            panel.orderOut(nil); note = "Move the player to uncover the spoken word in \(source.source)."; return
        }
        panel.setFrame(converted, display: true); panel.orderFrontRegardless()
        note = "Highlighting in \(source.source)."
    }
}
