import AppKit
import ArticleVoiceCore
import SwiftUI

private let ink = Color(red: 0.12, green: 0.23, blue: 0.18)
private let sage = Color(red: 0.19, green: 0.40, blue: 0.29)

struct ReaderView: View {
    @ObservedObject var model: ReaderModel
    @ObservedObject var companion: Companion
    @ObservedObject var focus: FocusCapture
    @ObservedObject var sourceMarker: SourceHighlight
    @State private var settings = false
    @State private var showHelp = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                Image(systemName: "waveform").font(.system(size: 23, weight: .semibold)).foregroundStyle(sage)
                Text("Article Voice").font(.system(size: 17, weight: .semibold))
                Spacer()
                HStack(spacing: 5) { Circle().fill(companion.ready ? sage : .orange).frame(width: 6, height: 6); Text(companion.ready ? "On your Mac" : "Preparing voices") }
                    .font(.system(size: 10, weight: .medium)).foregroundStyle(.secondary)
                Button { settings.toggle() } label: { Image(systemName: "slider.horizontal.3") }.buttonStyle(.plain).accessibilityLabel("Settings")
                    .popover(isPresented: $settings) { settingsPanel }
            }
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text(model.text.isEmpty ? "Listen where you work" : model.sourceName).font(.system(size: 23, weight: .semibold))
                    Text(model.text.isEmpty ? "Select text in another app, or paste it below." : "Click a word to listen from there.").font(.system(size: 12)).foregroundStyle(.secondary)
                }
                Spacer()
                if !model.text.isEmpty { Button("New text", action: model.newText).buttonStyle(.plain).font(.system(size: 11)).foregroundStyle(sage) }
            }
            HStack(spacing: 10) {
                Button { model.readSelection() } label: {
                    HStack { Image(systemName: "text.cursor"); Text("Read selection"); Spacer(); if model.shortcut.registered { Text(GlobalShortcut.label).font(.system(size: 11, weight: .medium, design: .monospaced)).opacity(0.75) } }
                        .padding(.vertical, 10).padding(.horizontal, 12).frame(maxWidth: .infinity)
                }.buttonStyle(.plain).foregroundStyle(.white).background(sage, in: RoundedRectangle(cornerRadius: 11))
                    .accessibilityLabel("Read selection from another app")
                Menu {
                    Button("Read focused area") { model.readSelection(focusedArea: true) }
                    Menu("Read from an open app") {
                        ForEach(focus.availableApplications, id: \.processIdentifier) { app in
                            Button(app.localizedName ?? "Open app") { model.readSelection(from: app) }
                        }
                    }
                    Button("Paste and read", action: model.paste)
                    Button("How to read from other apps") { showHelp = true }
                } label: { Image(systemName: "ellipsis").frame(width: 30, height: 38) }.menuStyle(.borderlessButton).fixedSize().accessibilityLabel("More reading options")
            }

            if !model.text.isEmpty, let note = sourceMarker.note {
                Text(note).font(.system(size: 11)).foregroundStyle(sage).accessibilityIdentifier("source-highlight-status")
            }

            if !focus.trusted {
                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: "hand.raised").foregroundStyle(sage)
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Read directly from other apps").font(.system(size: 12, weight: .semibold))
                        Text("Allow Accessibility for the shortcut. Paste and the Services menu work without it.").font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer(minLength: 0)
                    Button("Enable") { focus.requestPermission() }.accessibilityLabel("Enable Accessibility")
                }.padding(12).background(sage.opacity(0.06), in: RoundedRectangle(cornerRadius: 11))
            }

            if let error = model.error {
                HStack(alignment: .top) {
                    Image(systemName: "exclamationmark.circle")
                    Text(error).fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 0)
                    if !companion.ready { Button("Retry", action: model.prepareVoices) }
                    Button { model.error = nil } label: { Image(systemName: "xmark") }.buttonStyle(.plain).accessibilityLabel("Dismiss message")
                }.font(.system(size: 11)).foregroundStyle(Color(red: 0.55, green: 0.24, blue: 0.15)).padding(12)
                    .background(Color.orange.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
            }

            if model.text.isEmpty { composer }
            else {
                ReadAlongView(text: model.text, current: model.currentRange, passage: model.passageRange, follow: model.follow, seek: model.seekWord)
                    .frame(minHeight: 120, maxHeight: .infinity)
                    .background(Color.white.opacity(0.68), in: RoundedRectangle(cornerRadius: 14))
                    .overlay(RoundedRectangle(cornerRadius: 14).stroke(sage.opacity(0.12)))
            }

            VStack(spacing: 8) {
                HStack {
                    Text(statusText).font(.system(size: 11, weight: .medium)).accessibilityIdentifier("reading-status")
                    Spacer()
                    if model.total > 0 { Text("\(model.index + 1) of \(model.total) passages").font(.system(size: 10)).foregroundStyle(.secondary) }
                }
                Slider(value: Binding(get: { model.position }, set: model.seek), in: 0...max(0.01, model.duration))
                    .tint(sage).disabled(model.duration <= 0).accessibilityLabel("Reading position")
                HStack {
                    Text(time(model.position / model.speed)); Spacer(); Text(model.duration > 0 ? time(ceil(model.duration / model.speed)) : "Ready when you are")
                }.font(.system(size: 10, design: .monospaced)).foregroundStyle(.secondary)
            }

            HStack(spacing: 18) {
                Spacer()
                Button { model.jump(-5) } label: { Image(systemName: "gobackward.5").font(.system(size: 23)) }.buttonStyle(.plain).accessibilityLabel("Back five seconds").disabled(model.duration <= 0)
                Button(action: model.toggle) {
                    Group {
                        if model.state == .preparing { ProgressView().controlSize(.small).tint(.white) }
                        else { Image(systemName: model.state == .playing ? "pause.fill" : "play.fill").font(.system(size: 21)) }
                    }.frame(width: 56, height: 56).foregroundStyle(.white).background(sage, in: Circle())
                }.buttonStyle(.plain).disabled(!companion.ready || (model.text.isEmpty && model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty))
                    .accessibilityLabel(model.state == .playing || model.state == .preparing ? "Pause reading" : "Play reading")
                Button { model.jump(5) } label: { Image(systemName: "goforward.5").font(.system(size: 23)) }.buttonStyle(.plain).accessibilityLabel("Forward five seconds").disabled(model.duration <= 0)
                Spacer()
                Button(action: model.stop) { Image(systemName: "stop.fill").font(.system(size: 12)) }.buttonStyle(.plain).accessibilityLabel("Stop reading").disabled(model.text.isEmpty)
            }.foregroundStyle(sage)

            HStack(spacing: 12) {
                Picker("Voice", selection: Binding(get: { model.voiceID }, set: model.changeVoice)) {
                    if model.voices.isEmpty { Text("Getting voices ready…").tag(model.voiceID) }
                    ForEach(model.voices) { voice in Text("\(voice.name) · \(voice.language.uppercased())").tag(voice.id) }
                }.labelsHidden().frame(maxWidth: .infinity).accessibilityLabel("Reading voice")
                Button(action: model.previewVoice) { Image(systemName: model.previewing ? "stop.circle" : "speaker.wave.2") }.buttonStyle(.plain).accessibilityLabel(model.previewing ? "Stop voice preview" : "Preview voice").disabled(!companion.ready)
                Picker("Speed", selection: Binding(get: { model.speed }, set: model.changeSpeed)) {
                    ForEach([0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 2.75, 3], id: \.self) { value in Text("\(value.formatted())×").tag(value) }
                }.labelsHidden().frame(width: 85).accessibilityLabel("Playback speed")
            }
            HStack {
                Image(systemName: "lock").font(.system(size: 9)); Text("Text and audio stay on this Mac.")
                Spacer()
                Toggle("Follow words", isOn: $model.follow).toggleStyle(.checkbox)
            }.font(.system(size: 10)).foregroundStyle(.secondary)
        }
        .padding(20).foregroundStyle(ink).background(Color(red: 0.965, green: 0.970, blue: 0.947))
        .frame(minWidth: 430, idealWidth: 480, maxWidth: .infinity, minHeight: 720, idealHeight: 790, maxHeight: .infinity)
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in focus.refreshPermission() }
        .sheet(isPresented: $showHelp) { helpPanel }
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack { Text("Or bring your own text").font(.system(size: 12, weight: .medium)); Spacer(); Button("Paste and read", action: model.paste).buttonStyle(.plain).foregroundStyle(sage) }
            ZStack(alignment: .topLeading) {
                if model.draft.isEmpty { Text("Paste a paragraph, a message, or anything you’d like to hear…").font(.system(size: 15)).foregroundStyle(.tertiary).padding(9).allowsHitTesting(false) }
                TextEditor(text: $model.draft).font(.system(size: 16)).scrollContentBackground(.hidden).padding(3).accessibilityLabel("Text to read")
            }.frame(minHeight: 100, maxHeight: .infinity)
            HStack {
                Button("Try a sample", action: model.sample).buttonStyle(.plain).font(.system(size: 11)).foregroundStyle(sage)
                Spacer()
                Button("Read text", action: model.readDraft).buttonStyle(.borderedProminent).tint(sage).disabled(model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }.padding(16).background(.white.opacity(0.68), in: RoundedRectangle(cornerRadius: 14))
            .overlay(RoundedRectangle(cornerRadius: 14).stroke(sage.opacity(0.12)))
    }

    private var settingsPanel: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Your reader").font(.headline)
            Text(model.shortcut.registered ? "\(GlobalShortcut.label) reads from the last app you used." : "The shortcut isn’t available. Use Read selection or the Services menu.").font(.system(size: 12))
            Button("Read from other apps…") { settings = false; showHelp = true }
            Button("Enable Accessibility…") { focus.requestPermission() }
            Divider()
            Text(companion.status).font(.system(size: 11)).foregroundStyle(.secondary)
            if !companion.ready { Button("Retry voice setup", action: model.prepareVoices) }
            Button("Clear saved audio", action: model.clearCache)
            Button("Open voice engine log") { NSWorkspace.shared.open(appDataDirectory().appendingPathComponent("voice-engine.log")) }
            Text("Qwen3-TTS · speech runs locally\nSpeed changes reuse your audio.").font(.system(size: 10)).foregroundStyle(.secondary)
        }.padding(20).frame(width: 290)
    }

    private var helpPanel: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("Read what you’re working on").font(.system(size: 22, weight: .semibold))
            Text("1. Select a passage in another app.\n2. Press \(GlobalShortcut.keys).\n3. Listen, pause, or click a word to go back.").font(.system(size: 14)).lineSpacing(8)
            Text("For the shortcut, enable Article Voice in System Settings → Privacy & Security → Accessibility.")
            Text("You can also use the source app’s Services → Read with Article Voice menu without Accessibility access. Paste text here whenever an app doesn’t share its text.")
            Text("Focused-area reading depends on the app. Scanned images and canvas-only content need OCR, which isn’t included in this preview.").font(.system(size: 11)).foregroundStyle(.secondary)
            HStack { Button("Enable Accessibility") { focus.requestPermission() }; Spacer(); Button("Got it") { showHelp = false }.keyboardShortcut(.defaultAction) }
        }.padding(28).frame(width: 410)
    }

    private var statusText: String {
        if !companion.ready { return "Preparing local voices…" }
        switch model.state {
        case .idle: return model.text.isEmpty ? "Ready to listen" : "Press Play to start again"
        case .preparing: return "Preparing this passage…"
        case .playing: return "Reading · pitch preserved"
        case .paused: return "Paused"
        case .complete: return "Finished · play to listen again"
        }
    }
    private func time(_ value: Double) -> String { String(format: "%d:%02d", Int(value) / 60, Int(value) % 60) }
}
