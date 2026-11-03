import Foundation

/// Image-relative top-left coordinates. Raster-edge overshoot is limited to
/// one input pixel; malformed or materially outside rectangles stay invalid.
public struct NormalizedImageBox: Encodable {
    public let x: Double, y: Double, width: Double, height: Double

    public init?(bottomLeft rectangle: CGRect, imageWidth: Int, imageHeight: Int) {
        guard imageWidth > 0, imageHeight > 0,
              [rectangle.origin.x, rectangle.origin.y, rectangle.width, rectangle.height].allSatisfy(\.isFinite),
              rectangle.width > 0, rectangle.height > 0 else { return nil }
        let pixelX = 1 / Double(imageWidth), pixelY = 1 / Double(imageHeight)
        guard rectangle.minX >= -pixelX, rectangle.minY >= -pixelY,
              rectangle.maxX <= 1 + pixelX, rectangle.maxY <= 1 + pixelY else { return nil }
        let left = max(0, rectangle.minX), right = min(1, rectangle.maxX)
        let bottom = max(0, rectangle.minY), top = min(1, rectangle.maxY)
        guard right > left, top > bottom else { return nil }
        x = left; y = 1 - top; width = right - left; height = top - bottom
    }
}
