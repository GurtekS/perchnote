// VoiceProcessedMic.swift
// Echo-cancelled microphone capture via Apple's voice-processing I/O unit
// (kAudioUnitSubType_VoiceProcessingIO, reached through AVAudioEngine's
// inputNode.setVoiceProcessingEnabled). The unit subtracts what the SYSTEM
// is playing out of the speakers from the mic signal (AEC) — built for
// no-headphones meetings where the mic re-captures remote speech.
//
// Always binds the system-default input device; callers that need a specific
// mic must use the plain cpal path instead. Delivers f32 mono samples to Rust
// via a C callback function pointer (same pattern as ProcessAudioTap.swift).

import AVFAudio
import Foundation

@available(macOS 14.2, *)
private final class VoiceProcessedMicCapture {
    private var engine: AVAudioEngine? = nil
    var reportedSampleRate: Double = 48000

    deinit { stop() }

    func start(
        callback: @escaping @convention(c) (UnsafePointer<Float>, Int32, UnsafeMutableRawPointer?) -> Void,
        userData: UnsafeMutableRawPointer?
    ) -> Int32 {
        let engine = AVAudioEngine()
        let input = engine.inputNode

        // Swap the engine's I/O unit for kAudioUnitSubType_VoiceProcessingIO.
        // Throws when the unit can't be created (no input device, exotic
        // configurations) — the Rust caller falls back to plain capture.
        do {
            try input.setVoiceProcessingEnabled(true)
        } catch {
            NSLog("[MNVoiceMic] setVoiceProcessingEnabled failed: %@", error.localizedDescription)
            return -1
        }

        // VPIO ducks OTHER apps' output by default (macOS 14+) — which is
        // exactly the remote-participant audio this app simultaneously
        // records via the system tap. Keep ducking at the minimum.
        input.voiceProcessingOtherAudioDuckingConfiguration =
            AVAudioVoiceProcessingOtherAudioDuckingConfiguration(
                enableAdvancedDucking: false,
                duckingLevel: .min
            )

        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            NSLog("[MNVoiceMic] input node reports an empty format (no input device?)")
            try? input.setVoiceProcessingEnabled(false)
            return -2
        }
        reportedSampleRate = format.sampleRate

        // Local boxed state (no self capture — avoids a tap→self→engine cycle).
        var callbackCount = 0
        var firstNonZeroLogged = false

        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            let frames = Int(buffer.frameLength)
            guard frames > 0, let channels = buffer.floatChannelData else { return }
            let ch = Int(buffer.format.channelCount)

            callbackCount += 1
            if !firstNonZeroLogged {
                var peak: Float = 0
                for f in 0..<frames { peak = max(peak, abs(channels[0][f])) }
                if peak > 0.0001 {
                    NSLog("[MNVoiceMic] first non-zero audio: callbackCount=%d peak=%.4f frames=%d", callbackCount, peak, frames)
                    firstNonZeroLogged = true
                } else if callbackCount % 100 == 0 {
                    NSLog("[MNVoiceMic] callbacks=%d but all zero (muted mic?)", callbackCount)
                }
            }

            // VPIO renders mono; downmix defensively if a config ever isn't.
            if ch == 1 {
                callback(channels[0], Int32(frames), userData)
            } else {
                var mono = [Float](repeating: 0, count: frames)
                let inv = 1.0 / Float(ch)
                for c in 0..<ch {
                    let src = channels[c]
                    for f in 0..<frames { mono[f] += src[f] }
                }
                for f in 0..<frames { mono[f] *= inv }
                mono.withUnsafeBufferPointer { p in
                    callback(p.baseAddress!, Int32(frames), userData)
                }
            }
        }

        engine.prepare()
        do {
            try engine.start()
        } catch {
            NSLog("[MNVoiceMic] engine start failed: %@", error.localizedDescription)
            input.removeTap(onBus: 0)
            try? input.setVoiceProcessingEnabled(false)
            return -3
        }

        self.engine = engine
        NSLog(
            "[MNVoiceMic] voice-processed mic running at %.0fHz, %d ch",
            format.sampleRate, format.channelCount
        )
        return 0
    }

    func stop() {
        guard let engine = engine else { return }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        // Best-effort: release the voice-processing unit fully so a follow-up
        // plain capture (or VPIO rebuild) starts from a clean slate.
        try? engine.inputNode.setVoiceProcessingEnabled(false)
        self.engine = nil
    }
}

// MARK: - C-callable API (prefixed mn_ to match the other Swift helpers)

private func mnVoiceBoxRetain<T: AnyObject>(_ obj: T) -> OpaquePointer {
    OpaquePointer(Unmanaged.passRetained(obj).toOpaque())
}
private func mnVoiceBoxRelease(_ ptr: OpaquePointer) {
    Unmanaged<AnyObject>.fromOpaque(UnsafeRawPointer(ptr)).release()
}
private func mnVoiceBoxUnretained<T: AnyObject>(_ ptr: OpaquePointer) -> T {
    Unmanaged<T>.fromOpaque(UnsafeRawPointer(ptr)).takeUnretainedValue()
}

/// Create a capture object. Returns nil if macOS < 14.2.
@_cdecl("mn_voice_mic_create")
public func mnVoiceMicCreate() -> OpaquePointer? {
    guard #available(macOS 14.2, *) else { return nil }
    return mnVoiceBoxRetain(VoiceProcessedMicCapture())
}

/// Start capturing. `callback` is called on an AVAudioEngine render thread
/// with echo-cancelled mono f32 samples. Returns 0 on success, a negative
/// code on failure (the unit could not be created or started).
@_cdecl("mn_voice_mic_start")
public func mnVoiceMicStart(
    _ handle: OpaquePointer,
    _ callback: @convention(c) (UnsafePointer<Float>, Int32, UnsafeMutableRawPointer?) -> Void,
    _ userData: UnsafeMutableRawPointer?
) -> Int32 {
    guard #available(macOS 14.2, *) else { return -50 }
    let cap: VoiceProcessedMicCapture = mnVoiceBoxUnretained(handle)
    return cap.start(callback: callback, userData: userData)
}

/// Query the actual sample rate of the captured audio (call after start).
@_cdecl("mn_voice_mic_sample_rate")
public func mnVoiceMicSampleRate(_ handle: OpaquePointer) -> Double {
    guard #available(macOS 14.2, *) else { return 48000 }
    let cap: VoiceProcessedMicCapture = mnVoiceBoxUnretained(handle)
    return cap.reportedSampleRate
}

/// Stop capturing (idempotent).
@_cdecl("mn_voice_mic_stop")
public func mnVoiceMicStop(_ handle: OpaquePointer) {
    guard #available(macOS 14.2, *) else { return }
    let cap: VoiceProcessedMicCapture = mnVoiceBoxUnretained(handle)
    cap.stop()
}

/// Stop + destroy the capture object.
@_cdecl("mn_voice_mic_destroy")
public func mnVoiceMicDestroy(_ handle: OpaquePointer) {
    guard #available(macOS 14.2, *) else { return }
    let cap: VoiceProcessedMicCapture = mnVoiceBoxUnretained(handle)
    cap.stop()
    mnVoiceBoxRelease(handle)
}
