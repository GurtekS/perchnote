// ProcessAudioTap.swift
// Captures all system audio using CoreAudio CATapDescription (macOS 14.2+).
// No picker UI required — only needs Screen Recording TCC permission.
// Delivers f32 mono samples to Rust via a callback function pointer.

import CoreAudio
import AVFAudio
import Foundation

@available(macOS 14.2, *)
private class ProcessAudioCapture {
    var tapID: AudioObjectID = kAudioObjectUnknown
    var aggregateDeviceID: AudioObjectID = kAudioObjectUnknown
    var ioProcID: AudioDeviceIOProcID? = nil
    var reportedSampleRate: Double = 48000
    var callbackCount: Int = 0
    var firstNonZeroLogged: Bool = false

    deinit { stop() }

    func start(
        callback: @escaping @convention(c) (UnsafePointer<Float>, Int32, UnsafeMutableRawPointer?) -> Void,
        userData: UnsafeMutableRawPointer?
    ) -> Int32 {
        // Create a tap that mixes ALL system audio processes into a stereo stream.
        // stereoGlobalTapButExcludeProcesses([]) = exclude no processes = capture every process.
        // stereoMixdownOfProcesses([]) would mean "include zero processes" = silence.
        // Audio continues playing normally (not muted).
        let tapDesc = CATapDescription(stereoGlobalTapButExcludeProcesses: [])

        var status = AudioHardwareCreateProcessTap(tapDesc, &tapID)
        NSLog("[MNAudio] AudioHardwareCreateProcessTap status=%d tapID=%d", status, tapID)
        guard status == noErr else {
            return Int32(status)
        }

        let tapUID = tapDesc.uuid.uuidString

        // Create a private aggregate device whose only input is the tap.
        let aggUID = "com.perchnote.tap.\(tapUID)"
        let aggDesc: [String: Any] = [
            kAudioAggregateDeviceNameKey as String:        "MNCapture",
            kAudioAggregateDeviceUIDKey as String:         aggUID,
            kAudioAggregateDeviceIsPrivateKey as String:   1,
            kAudioAggregateDeviceSubDeviceListKey as String: [] as [Any],
            "taps": [                              // kAudioAggregateDeviceTapListKey
                ["uid": tapUID, "drift": 0]        // kAudioSubTapUIDKey / DriftCompensation
            ]
        ]

        status = AudioHardwareCreateAggregateDevice(aggDesc as CFDictionary, &aggregateDeviceID)
        NSLog("[MNAudio] AudioHardwareCreateAggregateDevice status=%d aggID=%d", status, aggregateDeviceID)
        guard status == noErr else { destroyTap(); return Int32(status) }

        // Query the aggregate device's actual sample rate.
        var srAddr = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyNominalSampleRate,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var sr: Float64 = 48000
        var srSize = UInt32(MemoryLayout<Float64>.size)
        AudioObjectGetPropertyData(aggregateDeviceID, &srAddr, 0, nil, &srSize, &sr)
        if sr > 0 { reportedSampleRate = sr }

        // Register an IO proc to receive audio buffers from the aggregate device.
        var ioProc: AudioDeviceIOProcID? = nil
        status = AudioDeviceCreateIOProcIDWithBlock(&ioProc, aggregateDeviceID, nil) {
            _, inInputData, _, _, _ in

            let nbufs = Int(inInputData.pointee.mNumberBuffers)
            guard nbufs >= 1 else { return }

            // mBuffers is the first AudioBuffer in the variable-length struct.
            // For a stereo mixdown tap there will be exactly 1 or 2 buffers.
            // We take the first (or downmix manually below).
            withUnsafePointer(to: inInputData.pointee.mBuffers) { firstBuf in
                // Build a Swift array of all AudioBuffers via raw pointer arithmetic.
                let bufPtr = UnsafeRawPointer(firstBuf)
                var mono = [Float]()

                for i in 0..<nbufs {
                    let buf = bufPtr
                        .advanced(by: i * MemoryLayout<AudioBuffer>.stride)
                        .assumingMemoryBound(to: AudioBuffer.self)
                        .pointee
                    guard let data = buf.mData, buf.mDataByteSize > 0 else { continue }
                    let ch = Int(buf.mNumberChannels)
                    let frames = Int(buf.mDataByteSize) / (MemoryLayout<Float>.size * max(ch, 1))
                    let samples = data.bindMemory(to: Float.self, capacity: frames * ch)

                    // Downmix channels to mono
                    if ch <= 1 {
                        for f in 0..<frames { mono.append(samples[f]) }
                    } else {
                        let inv = 1.0 / Float(ch)
                        for f in 0..<frames {
                            var sum: Float = 0
                            for c in 0..<ch { sum += samples[f * ch + c] }
                            mono.append(sum * inv)
                        }
                    }
                }

                if !mono.isEmpty {
                    self.callbackCount += 1
                    if !self.firstNonZeroLogged {
                        let peak = mono.map { abs($0) }.max() ?? 0
                        if peak > 0.0001 {
                            NSLog("[MNAudio] first non-zero audio: callbackCount=%d peak=%.4f samples=%d", self.callbackCount, peak, mono.count)
                            self.firstNonZeroLogged = true
                        } else if self.callbackCount % 100 == 0 {
                            NSLog("[MNAudio] callbacks=%d but all zero (silent tap?)", self.callbackCount)
                        }
                    }
                    mono.withUnsafeBufferPointer { p in
                        callback(p.baseAddress!, Int32(p.count), userData)
                    }
                }
            }
        }

        guard status == noErr, let ioProc = ioProc else {
            destroyAggDev(); destroyTap()
            return Int32(status == noErr ? -1 : status)
        }
        self.ioProcID = ioProc

        status = AudioDeviceStart(aggregateDeviceID, ioProc)
        NSLog("[MNAudio] AudioDeviceStart status=%d sampleRate=%.0f", status, reportedSampleRate)
        guard status == noErr else {
            AudioDeviceDestroyIOProcID(aggregateDeviceID, ioProc)
            self.ioProcID = nil
            destroyAggDev(); destroyTap()
            return Int32(status)
        }

        return 0  // noErr
    }

    func stop() {
        if let proc = ioProcID, aggregateDeviceID != kAudioObjectUnknown {
            AudioDeviceStop(aggregateDeviceID, proc)
            AudioDeviceDestroyIOProcID(aggregateDeviceID, proc)
        }
        ioProcID = nil
        destroyAggDev()
        destroyTap()
    }

    private func destroyAggDev() {
        if aggregateDeviceID != kAudioObjectUnknown {
            AudioHardwareDestroyAggregateDevice(aggregateDeviceID)
            aggregateDeviceID = kAudioObjectUnknown
        }
    }

    private func destroyTap() {
        if tapID != kAudioObjectUnknown {
            AudioHardwareDestroyProcessTap(tapID)
            tapID = kAudioObjectUnknown
        }
    }
}

// MARK: - C-callable API (prefixed mn_ to avoid conflicts with screencapturekit bridge)

private func mnBoxRetain<T: AnyObject>(_ obj: T) -> OpaquePointer {
    OpaquePointer(Unmanaged.passRetained(obj).toOpaque())
}
private func mnBoxRelease(_ ptr: OpaquePointer) {
    Unmanaged<AnyObject>.fromOpaque(UnsafeRawPointer(ptr)).release()
}
private func mnBoxUnretained<T: AnyObject>(_ ptr: OpaquePointer) -> T {
    Unmanaged<T>.fromOpaque(UnsafeRawPointer(ptr)).takeUnretainedValue()
}

/// Create a capture object. Returns nil if macOS < 14.2.
@_cdecl("mn_process_audio_tap_create")
public func mnProcessAudioTapCreate() -> OpaquePointer? {
    guard #available(macOS 14.2, *) else { return nil }
    return mnBoxRetain(ProcessAudioCapture())
}

/// Start capturing. Returns 0 on success, CoreAudio OSStatus on failure.
@_cdecl("mn_process_audio_tap_start")
public func mnProcessAudioTapStart(
    _ handle: OpaquePointer,
    _ callback: @convention(c) (UnsafePointer<Float>, Int32, UnsafeMutableRawPointer?) -> Void,
    _ userData: UnsafeMutableRawPointer?
) -> Int32 {
    guard #available(macOS 14.2, *) else { return -50 }
    let cap: ProcessAudioCapture = mnBoxUnretained(handle)
    return cap.start(callback: callback, userData: userData)
}

/// Query the actual sample rate of the captured audio (call after start).
@_cdecl("mn_process_audio_tap_sample_rate")
public func mnProcessAudioTapSampleRate(_ handle: OpaquePointer) -> Double {
    guard #available(macOS 14.2, *) else { return 48000 }
    let cap: ProcessAudioCapture = mnBoxUnretained(handle)
    return cap.reportedSampleRate
}

/// Stop capturing (idempotent).
@_cdecl("mn_process_audio_tap_stop")
public func mnProcessAudioTapStop(_ handle: OpaquePointer) {
    guard #available(macOS 14.2, *) else { return }
    let cap: ProcessAudioCapture = mnBoxUnretained(handle)
    cap.stop()
}

/// Stop + destroy the capture object.
@_cdecl("mn_process_audio_tap_destroy")
public func mnProcessAudioTapDestroy(_ handle: OpaquePointer) {
    guard #available(macOS 14.2, *) else { return }
    let cap: ProcessAudioCapture = mnBoxUnretained(handle)
    cap.stop()
    mnBoxRelease(handle)
}
