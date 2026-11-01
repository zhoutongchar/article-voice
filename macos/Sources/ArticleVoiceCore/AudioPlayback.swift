import AVFAudio
import Foundation

@MainActor public final class AudioPlayback {
    private let engine = AVAudioEngine()
    private let node = AVAudioPlayerNode()
    private let pitch = AVAudioUnitTimePitch()
    private let format = AVAudioFormat(standardFormatWithSampleRate: 24000, channels: 1)!
    private var pcm = Data()
    private var offset = 0.0
    private var pausedAt = 0.0
    private var generation = UUID()
    private var timer: Timer?
    private var queued = 0
    private var waiting = false
    private var finished = true
    private var wantsPlay = false
    public private(set) var duration = 0.0
    public private(set) var isPlaying = false
    public var onPosition: ((Double) -> Void)?
    public var onEnd: (() -> Void)?
    public var onBuffering: ((Bool) -> Void)?
    public var reachedEnd: Bool { finished && waiting && queued == 0 && duration > 0 }

    public init() {
        engine.attach(node); engine.attach(pitch)
        engine.connect(node, to: pitch, format: format)
        engine.connect(pitch, to: engine.mainMixerNode, format: format)
        pitch.pitch = 0; pitch.rate = 1
        timer = Timer.scheduledTimer(withTimeInterval: 1 / 30, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { guard let self, self.isPlaying else { return }; self.onPosition?(self.position) }
        }
    }

    public var position: Double {
        if !isPlaying { return pausedAt }
        guard let rendered = node.lastRenderTime, let time = node.playerTime(forNodeTime: rendered) else { return offset }
        return min(duration, offset + Double(time.sampleTime) / time.sampleRate)
    }

    public func setSpeed(_ speed: Double) { pitch.rate = Float(min(3, max(0.5, speed))) }

    public func begin(play: Bool = true) {
        stop(); finished = false; wantsPlay = play; waiting = true
        onBuffering?(play)
    }

    public func append(_ clip: SpeechClip) throws {
        guard clip.sampleRate == 24000, !clip.pcm.isEmpty, clip.pcm.count % 2 == 0,
              pcm.count + clip.pcm.count <= 16 * 1024 * 1024 else { throw ReaderError.audio }
        let previous = duration
        let starved = waiting || (isPlaying && position >= previous - 1 / 24000)
        pcm.append(clip.pcm)
        duration = Double(pcm.count) / 48000
        if starved { try schedule(from: previous, play: wantsPlay) }
        else { try enqueue(clip.pcm) }
    }

    public func finish() {
        finished = true
        if waiting && queued == 0 && duration > 0 { completed() }
    }

    public func load(_ clip: SpeechClip, at position: Double = 0, play: Bool = true) throws {
        stop()
        pcm = clip.pcm; duration = clip.duration; finished = true
        try schedule(from: position, play: play)
    }

    public func seek(_ requested: Double, play: Bool = true) throws {
        try schedule(from: min(max(0, requested), max(0, duration - 0.02)), play: play)
    }

    private func schedule(from requested: Double, play: Bool) throws {
        generation = UUID(); node.stop(); queued = 0; isPlaying = false
        offset = min(max(0, requested), duration); pausedAt = offset; wantsPlay = play
        let start = min(pcm.count, Int((offset * 24000).rounded()) * 2)
        guard start < pcm.count else { waiting = true; onBuffering?(play && !finished); return }
        if !engine.isRunning { try engine.start() }
        waiting = false
        try enqueue(pcm.subdata(in: start..<pcm.count))
        onPosition?(offset); onBuffering?(false)
        if play { node.play(); isPlaying = true }
    }

    private func enqueue(_ data: Data) throws {
        let count = data.count / 2
        guard count > 0, let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(count)),
              let channel = buffer.floatChannelData?[0] else { throw ReaderError.audio }
        buffer.frameLength = AVAudioFrameCount(count)
        data.withUnsafeBytes { bytes in
            for index in 0..<count {
                channel[index] = Float(Int16(littleEndian: bytes.loadUnaligned(fromByteOffset: index * 2, as: Int16.self))) / 32768
            }
        }
        let ticket = generation
        queued += 1
        node.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.generation == ticket else { return }
                self.queued -= 1
                guard self.queued == 0 else { return }
                self.node.stop(); self.isPlaying = false; self.waiting = true
                self.pausedAt = self.duration; self.offset = self.duration
                self.onPosition?(self.duration)
                if self.finished { self.completed() }
                else { self.onBuffering?(self.wantsPlay) }
            }
        }
    }

    private func completed() {
        isPlaying = false; pausedAt = duration; waiting = true; wantsPlay = false
        onPosition?(duration); onBuffering?(false); onEnd?()
    }

    public func pause() {
        pausedAt = position; node.pause(); isPlaying = false; wantsPlay = false
        onPosition?(pausedAt); onBuffering?(false)
    }
    public func resume() {
        wantsPlay = true
        guard !pcm.isEmpty, !reachedEnd else { return }
        if waiting { onBuffering?(!finished); return }
        node.play(); isPlaying = true; onBuffering?(false)
    }
    public func stop() {
        generation = UUID(); node.stop(); queued = 0; isPlaying = false
        pcm = Data(); offset = 0; pausedAt = 0; duration = 0
        finished = true; waiting = false; wantsPlay = false
    }
}
