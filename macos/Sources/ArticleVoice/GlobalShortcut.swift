import Carbon
import Foundation

@MainActor final class GlobalShortcut {
    static let label = "⌘⇧S"
    static let keys = "Command–Shift–S"
    private var hotkey: EventHotKeyRef?
    private var handler: EventHandlerRef?
    var action: (() -> Void)?
    private(set) var registered = false

    init() {
        var type = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        let context = Unmanaged.passUnretained(self).toOpaque()
        let installed = InstallEventHandler(GetApplicationEventTarget(), { _, _, context in
            guard let context else { return noErr }
            let shortcut = Unmanaged<GlobalShortcut>.fromOpaque(context).takeUnretainedValue()
            Task { @MainActor in shortcut.action?() }
            return noErr
        }, 1, &type, context, &handler)
        guard installed == noErr else { return }
        let identity = EventHotKeyID(signature: 0x41565244, id: 1)
        registered = RegisterEventHotKey(UInt32(kVK_ANSI_S), UInt32(cmdKey | shiftKey), identity,
                                        GetApplicationEventTarget(), 0, &hotkey) == noErr
    }
}
