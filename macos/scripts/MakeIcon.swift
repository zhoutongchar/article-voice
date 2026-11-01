import AppKit

let directory = URL(fileURLWithPath: CommandLine.arguments[1])
try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
for size in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        let pixels = size * scale
        let image = NSImage(size: NSSize(width: pixels, height: pixels))
        image.lockFocus()
        let unit = CGFloat(pixels) / 1024
        NSColor(calibratedRed: 0.95, green: 0.96, blue: 0.91, alpha: 1).setFill()
        NSBezierPath(roundedRect: NSRect(x: 28 * unit, y: 28 * unit, width: 968 * unit, height: 968 * unit), xRadius: 205 * unit, yRadius: 205 * unit).fill()
        NSColor(calibratedRed: 0.19, green: 0.40, blue: 0.29, alpha: 1).setFill()
        for (index, height) in [150, 310, 220, 440, 190].enumerated() {
            NSBezierPath(roundedRect: NSRect(x: CGFloat(224 + index * 118) * unit, y: CGFloat(512 - height / 2) * unit,
                                           width: 94 * unit, height: CGFloat(height) * unit), xRadius: 44 * unit, yRadius: 44 * unit).fill()
        }
        image.unlockFocus()
        let bitmap = NSBitmapImageRep(data: image.tiffRepresentation!)!
        let name = "icon_\(size)x\(size)\(scale == 2 ? "@2x" : "").png"
        try bitmap.representation(using: .png, properties: [:])!.write(to: directory.appendingPathComponent(name))
    }
}
