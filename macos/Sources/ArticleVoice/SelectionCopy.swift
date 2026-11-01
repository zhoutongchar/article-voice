import AppKit
import ArticleVoiceCore

@MainActor enum SelectionCopy {
    static func read(from pid: pid_t) async throws -> String? {
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else { return nil }
        let board = NSPasteboard.general, before = NSPasteboard.general.changeCount
        guard let saved = ClipboardSnapshot(board), board.changeCount == before else { return nil }
        try Task.checkCancellation()
        guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 8, keyDown: true),
              let up = CGEvent(keyboardEventSource: nil, virtualKey: 8, keyDown: false) else { return nil }
        down.flags = .maskCommand; up.flags = .maskCommand
        down.postToPid(pid); up.postToPid(pid)
        // Finish cleanup if cancellation arrives while the source copies.
        for _ in 0..<12 {
            if board.changeCount != before { break }
            // This unstructured wait is deliberately independent of the read
            // task's cancellation so a pending copy can still be restored.
            await Task { try? await Task.sleep(for: .milliseconds(50)) }.value
        }
        guard board.changeCount != before else { try Task.checkCancellation(); return nil }
        let copied = board.changeCount, text = board.string(forType: .string)
        saved.restore(board, replacing: copied)
        try Task.checkCancellation()
        return text?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false ? text : nil
    }
}
