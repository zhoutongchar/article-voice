import Foundation
import Vision
import ImageIO
import ArticleVoiceCore

struct OCRInput: Decodable { let image: String; let language: String? }
struct Word: Encodable { let start: Int, end: Int; let box: NormalizedImageBox }
struct Line: Encodable { let text: String; let box: NormalizedImageBox; let words: [Word] }
struct Page: Encodable { let width: Int, height: Int; let lines: [Line] }
struct OCRFailure: Error { let message: String }

do {
    let input = try JSONDecoder().decode(OCRInput.self, from: FileHandle.standardInput.readToEnd() ?? Data())
    guard input.image.utf8.count <= 11_184_812, let data = Data(base64Encoded: input.image),
          data.count <= 8 * 1024 * 1024,
          let source = CGImageSourceCreateWithData(data as CFData, nil),
          let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
          let width = properties[kCGImagePropertyPixelWidth] as? Int,
          let height = properties[kCGImagePropertyPixelHeight] as? Int,
          width > 0, height > 0, width <= 16_000_000 / height,
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
        throw OCRFailure(message: "This page image could not be read. Try a smaller reader window.")
    }
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    request.automaticallyDetectsLanguage = true
    if let language = input.language, !language.isEmpty {
        let supported = try request.supportedRecognitionLanguages()
        let matches = supported.filter { $0 == language || $0.hasPrefix(language + "-") }
        if !matches.isEmpty { request.recognitionLanguages = matches }
    }
    try VNImageRequestHandler(cgImage: image).perform([request])
    var lines = [Line]()
    for observation in request.results ?? [] {
        guard let candidate = observation.topCandidates(1).first else { continue }
        let text = candidate.string
        guard let lineBox = NormalizedImageBox(bottomLeft: observation.boundingBox, imageWidth: width, imageHeight: height) else {
            throw OCRFailure(message: "The text recognizer returned a rectangle outside this page.")
        }
        var words = [Word]()
        var invalidWordBox = false
        text.enumerateSubstrings(in: text.startIndex..<text.endIndex, options: .byWords) { _, range, _, stop in
            if let rectangle = try? candidate.boundingBox(for: range) {
                guard let box = NormalizedImageBox(bottomLeft: rectangle.boundingBox, imageWidth: width, imageHeight: height) else {
                    invalidWordBox = true; stop = true; return
                }
                let offsets = NSRange(range, in: text)
                words.append(Word(start: offsets.location, end: offsets.location + offsets.length, box: box))
            }
        }
        guard !invalidWordBox else { throw OCRFailure(message: "The text recognizer returned a word rectangle outside this page.") }
        if !words.isEmpty { lines.append(Line(text: text, box: lineBox, words: words)) }
    }
    guard !lines.isEmpty else { throw OCRFailure(message: "No readable text was found on this page.") }
    let output = try JSONEncoder().encode(Page(width: width, height: height, lines: lines))
    guard output.count < 1024 * 1024 else { throw OCRFailure(message: "This page contains too much text. Increase the book’s font size and try again.") }
    FileHandle.standardOutput.write(output)
} catch {
    let message = (error as? OCRFailure)?.message ?? "The page could not be recognized. Try again."
    let data = try! JSONEncoder().encode(["error": message])
    FileHandle.standardOutput.write(data)
    exit(1)
}
