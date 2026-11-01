// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "ArticleVoice",
    platforms: [.macOS("26.0")],
    products: [
        .executable(name: "ArticleVoice", targets: ["ArticleVoice"]),
        .executable(name: "ArticleVoiceHost", targets: ["ArticleVoiceHost"]),
        .executable(name: "ArticleVoiceOCR", targets: ["ArticleVoiceOCR"]),
        .executable(name: "ArticleVoiceSmoke", targets: ["ArticleVoiceSmoke"]),
        .executable(name: "ArticleVoiceCoreChecks", targets: ["ArticleVoiceCoreChecks"]),
    ],
    targets: [
        .executableTarget(name: "ArticleVoiceHost"),
        .executableTarget(name: "ArticleVoiceOCR"),
        .target(name: "ArticleVoiceCore"),
        .executableTarget(name: "ArticleVoice", dependencies: ["ArticleVoiceCore"],
            exclude: ["FocusCapture.swift", "GlobalShortcut.swift", "ReadAlongView.swift", "ReaderModel.swift", "ReaderView.swift", "SelectionCopy.swift"]),
        .executableTarget(name: "ArticleVoiceSmoke", dependencies: ["ArticleVoiceCore"]),
        .executableTarget(name: "ArticleVoiceCoreChecks", dependencies: ["ArticleVoiceCore"], path: "Checks"),
    ],
    swiftLanguageModes: [.v5]
)
