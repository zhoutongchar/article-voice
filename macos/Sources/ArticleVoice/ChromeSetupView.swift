import SwiftUI

struct ChromeSetupView: View {
    @ObservedObject var setup: ChromeSetup
    private let ink = Color(red: 0.14, green: 0.25, blue: 0.19)
    private let green = Color(red: 0.20, green: 0.42, blue: 0.31)
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                HStack(spacing: 10) {
                    Image(systemName: "waveform").font(.system(size: 24, weight: .medium)).foregroundStyle(green)
                    Text("Article Voice").font(.system(size: 16, weight: .semibold))
                    Spacer()
                    if setup.preview { Text("PREVIEW").font(.system(size: 10, weight: .semibold)).tracking(1.3).foregroundStyle(.secondary) }
                }
                VStack(alignment: .leading, spacing: 14) {
                    Text(setup.ready ? "Your next article,\nwith a familiar voice." : "A good voice.\nRight where you read.")
                        .font(.system(size: 39, weight: .regular, design: .serif)).lineSpacing(1).fixedSize(horizontal: false, vertical: true)
                    Text(setup.ready ? "Chrome is connected. You’re ready to listen." : "Natural voices in Chrome, without accounts, API keys, or a monthly speech bill.")
                        .font(.system(size: 15)).foregroundStyle(.secondary).lineSpacing(4)
                }
                VStack(spacing: 0) {
                    step("1", title: setup.installed ? "Article Voice is installed" : "Install on this Mac", detail: "The app takes care of your voices.", complete: setup.installed)
                    Divider().padding(.leading, 53)
                    VStack(alignment: .leading, spacing: 10) {
                        step("2", title: setup.voicesReady ? "Your voices are ready" : "Prepare your voices", detail: setup.message, complete: setup.voicesReady)
                        if setup.installed && (setup.busy || setup.voicesReady) {
                            VStack(alignment: .leading, spacing: 6) {
                                if let fraction = setup.fraction { ProgressView(value: fraction).tint(green) }
                                else { ProgressView().controlSize(.small) }
                                Text(setup.bytes.isEmpty ? "First setup downloads 3.6 GB. You can pause and resume." : setup.bytes)
                                    .font(.system(size: 11)).foregroundStyle(.secondary)
                            }.padding(.leading, 53).padding(.bottom, 14)
                        }
                    }
                    Divider().padding(.leading, 53)
                    step("3", title: setup.chromeTitle, detail: setup.chromeDetail, complete: setup.chromeConnected)
                }.padding(18).background(.white.opacity(0.78), in: RoundedRectangle(cornerRadius: 18))
                if let error = setup.error {
                    Text(error).font(.system(size: 13)).foregroundStyle(Color(red: 0.65, green: 0.24, blue: 0.11))
                        .padding(14).frame(maxWidth: .infinity, alignment: .leading).background(Color.orange.opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
                        .accessibilityIdentifier("setup-error")
                }
                HStack(spacing: 12) {
                    if !setup.installed {
                        Button(setup.busy ? "Installing…" : "Install Article Voice") { setup.install() }.buttonStyle(.borderedProminent).disabled(setup.busy)
                    } else if setup.ready {
                        Button("Try a reading") { setup.tryReading() }.buttonStyle(.borderedProminent)
                    } else {
                        Button(setup.chromeAction) { setup.connectChrome() }.buttonStyle(.borderedProminent)
                        if setup.busy && !setup.voicesReady { Button("Pause download") { setup.cancel() }.buttonStyle(.bordered) }
                        else if !setup.voicesReady { Button("Resume setup") { setup.prepare() }.buttonStyle(.bordered) }
                        if setup.chromeConnected { Button("Try a reading") { setup.tryReading() }.buttonStyle(.bordered) }
                    }
                }.controlSize(.large).tint(green)
                if setup.showPreviewHelp {
                    VStack(alignment: .leading, spacing: 10) {
                        Text(setup.hasConnectedBefore ? "Reconnect this preview" : "Connect this preview").font(.system(size: 14, weight: .semibold))
                        Text("Your voices stay installed. The public release will open the Chrome Web Store; this preview uses a local extension.").font(.system(size: 12)).foregroundStyle(.secondary)
                        Text("1. Open Chrome Extensions and enable Developer mode.\n2. If Article Voice is listed, enable it or click its reload button.\n3. If it was removed, choose Load unpacked and select the ChromeExtension folder inside this app.").font(.system(size: 12)).lineSpacing(5)
                        HStack { Button("Open Chrome Extensions") { setup.openExtensions() }; Button("Show extension folder") { setup.revealExtension() } }.controlSize(.small)
                        Text(setup.resources.appendingPathComponent("ChromeExtension").path).font(.system(size: 10, design: .monospaced)).textSelection(.enabled).foregroundStyle(.secondary)
                    }.padding(16).background(.white.opacity(0.7), in: RoundedRectangle(cornerRadius: 12))
                }
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: "lock").padding(.top, 2)
                    Text("Speech stays on this Mac. Once your voices are ready, reading works offline. No Accessibility or screen-recording access needed.").lineSpacing(3)
                }.font(.system(size: 11)).foregroundStyle(.secondary)
            }.padding(36)
        }.background(Color(red: 0.965, green: 0.970, blue: 0.952)).foregroundStyle(ink).frame(minWidth: 530, minHeight: 650)
    }
    private func step(_ number: String, title: String, detail: String, complete: Bool) -> some View {
        HStack(alignment: .top, spacing: 15) {
            ZStack {
                Circle().fill(complete ? green.opacity(0.11) : Color.gray.opacity(0.07)).frame(width: 35, height: 35)
                if complete { Image(systemName: "checkmark").font(.system(size: 13, weight: .semibold)).foregroundStyle(green) }
                else { Text(number).font(.system(size: 13, weight: .medium)).foregroundStyle(.secondary) }
            }
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.system(size: 14, weight: .semibold))
                Text(detail).font(.system(size: 12)).foregroundStyle(.secondary).lineSpacing(3).fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }.padding(.vertical, 14)
    }
}
