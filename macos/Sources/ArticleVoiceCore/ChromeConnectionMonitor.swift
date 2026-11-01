import Foundation

public enum ChromeConnectionStatus: Equatable {
    case chromeClosed, checking, connected, disconnected
}

private struct ChromeHeartbeat: Decodable {
    let protocolVersion: Int?
    let extensionId: String
    let connectedAt: TimeInterval
}

/// A past installation is useful for reconnect instructions, but only a recent
/// heartbeat from the background extension establishes a live connection.
public struct ChromeConnectionMonitor {
    public private(set) var hasConnectedBefore = false
    private var wasRunning = false
    private var checkingSince: TimeInterval?
    public init() {}

    public mutating func update(receipt: Data?, extensionId: String, chromeRunning: Bool,
                                now: TimeInterval, waking: Bool = false) -> ChromeConnectionStatus {
        let heartbeat = receipt.flatMap { try? JSONDecoder().decode(ChromeHeartbeat.self, from: $0) }
        let matching = heartbeat?.extensionId == extensionId
        if matching { hasConnectedBefore = true }
        defer { wasRunning = chromeRunning }
        guard chromeRunning else { checkingSince = nil; return .chromeClosed }
        if !wasRunning || waking { checkingSince = now }
        if matching, let heartbeat, heartbeat.protocolVersion == 1,
           heartbeat.connectedAt <= now, now - heartbeat.connectedAt < 90 {
            return .connected
        }
        // Give Chrome's sleeping service worker time to wake after launch or a
        // Mac wake. Closing Chrome never means the extension was removed.
        if let checkingSince, now - checkingSince < 35 { return .checking }
        return .disconnected
    }
}
