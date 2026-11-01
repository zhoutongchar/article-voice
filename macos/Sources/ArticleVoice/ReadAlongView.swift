import AppKit
import SwiftUI

struct ReadAlongView: NSViewRepresentable {
    let text: String
    let current: NSRange?
    let passage: NSRange?
    let follow: Bool
    let seek: (Int) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(seek: seek) }
    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true; scroll.drawsBackground = false
        let view = NSTextView()
        view.isEditable = false; view.isSelectable = true
        view.drawsBackground = false; view.textContainerInset = NSSize(width: 18, height: 18)
        view.textContainer?.widthTracksTextView = true
        view.isHorizontallyResizable = false; view.autoresizingMask = [.width]
        view.linkTextAttributes = [.foregroundColor: NSColor(calibratedRed: 0.13, green: 0.22, blue: 0.17, alpha: 1), .underlineStyle: 0]
        view.delegate = context.coordinator
        view.setAccessibilityLabel("Read-along text. Click a word to listen from there.")
        scroll.documentView = view
        return scroll
    }
    func updateNSView(_ scroll: NSScrollView, context: Context) {
        guard let view = scroll.documentView as? NSTextView, let storage = view.textStorage else { return }
        let coordinator = context.coordinator
        coordinator.seek = seek
        if coordinator.text != text {
            coordinator.text = text; coordinator.current = nil; coordinator.passage = nil
            let style = NSMutableParagraphStyle(); style.lineSpacing = 8; style.paragraphSpacing = 8
            let attributed = NSMutableAttributedString(string: text, attributes: [
                .font: NSFont.systemFont(ofSize: 19, weight: .regular), .paragraphStyle: style,
                .foregroundColor: NSColor(calibratedRed: 0.13, green: 0.22, blue: 0.17, alpha: 1),
            ])
            text.enumerateSubstrings(in: text.startIndex..<text.endIndex, options: .byWords) { _, range, _, _ in
                let nsRange = NSRange(range, in: text)
                attributed.addAttribute(.link, value: URL(string: "articlevoice://seek/\(nsRange.location)")!, range: nsRange)
            }
            storage.setAttributedString(attributed)
        }
        guard coordinator.current != current || coordinator.passage != passage else { return }
        let passageColor = NSColor(calibratedRed: 0.87, green: 0.93, blue: 0.87, alpha: 1)
        storage.beginEditing()
        if coordinator.passage != passage {
            if let old = coordinator.passage, NSMaxRange(old) <= storage.length { storage.removeAttribute(.backgroundColor, range: old) }
            if let old = coordinator.current, NSMaxRange(old) <= storage.length { storage.removeAttribute(.backgroundColor, range: old) }
            if let passage, NSMaxRange(passage) <= storage.length { storage.addAttribute(.backgroundColor, value: passageColor, range: passage) }
        } else if let old = coordinator.current, NSMaxRange(old) <= storage.length {
            storage.removeAttribute(.backgroundColor, range: old)
            if let passage {
                let restored = NSIntersectionRange(old, passage)
                if restored.length > 0 { storage.addAttribute(.backgroundColor, value: passageColor, range: restored) }
            }
        }
        if let current, NSMaxRange(current) <= storage.length { storage.addAttribute(.backgroundColor, value: NSColor(calibratedRed: 1, green: 0.81, blue: 0.28, alpha: 1), range: current) }
        storage.endEditing()
        coordinator.current = current; coordinator.passage = passage
        if follow, let current { view.scrollRangeToVisible(current) }
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        var seek: (Int) -> Void
        var text = ""
        var current: NSRange?
        var passage: NSRange?
        init(seek: @escaping (Int) -> Void) { self.seek = seek }
        func textView(_ textView: NSTextView, clickedOnLink link: Any, at charIndex: Int) -> Bool {
            guard let url = link as? URL, url.scheme == "articlevoice", let offset = Int(url.lastPathComponent) else { return false }
            seek(offset); return true
        }
    }
}
