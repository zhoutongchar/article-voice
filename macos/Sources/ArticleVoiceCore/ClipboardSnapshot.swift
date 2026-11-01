import AppKit

@MainActor public struct ClipboardSnapshot {
    private let items: [[(NSPasteboard.PasteboardType, Data)]]

    public init?(_ board: NSPasteboard) {
        let original = board.changeCount
        var items: [[(NSPasteboard.PasteboardType, Data)]] = [], bytes = 0
        for item in board.pasteboardItems ?? [] {
            var representations: [(NSPasteboard.PasteboardType, Data)] = []
            for type in item.types {
                guard let data = item.data(forType: type) else { return nil }
                bytes += data.count
                guard bytes <= 16 * 1024 * 1024 else { return nil }
                representations.append((type, data))
            }
            items.append(representations)
        }
        guard board.changeCount == original else { return nil }
        self.items = items
    }

    @discardableResult public func restore(_ board: NSPasteboard, replacing changeCount: Int) -> Bool {
        guard board.changeCount == changeCount else { return false }
        let restored = items.map { representations in
            let item = NSPasteboardItem()
            for (type, data) in representations { item.setData(data, forType: type) }
            return item
        }
        board.clearContents()
        return restored.isEmpty || board.writeObjects(restored)
    }
}
