// SpeechEngine.swift
//
// Bridge to Apple's SpeechAnalyzer/SpeechTranscriber stack (macOS 26+) —
// the zero-download transcription engine option (plan v9 #12). Exposes two
// C-callable entry points used by `transcription/apple.rs`:
//
//   mn_speech_available()                          -> Bool
//   mn_speech_transcribe_file(path, locale, cb, _) -> Int32
//
// `mn_speech_transcribe_file` transcribes a 16kHz mono WAV file and invokes
// the callback exactly ONCE before returning:
//   - on success (return 0): a JSON array  [{"text","start_ms","end_ms"}, …]
//   - on failure (return <0): a JSON object {"__error": "detail"}
// The callback's buffer is only valid for the duration of the call — the
// Rust side copies it out immediately.
//
// SpeechTranscriber is only present in the macOS 26 SDK/runtime. Every
// reference sits behind `if #available(macOS 26, *)` / `@available`, and the
// module compiles against the app's 14.2 deployment floor — which makes
// swiftc emit the 26-only Speech symbols as WEAK imports. The binary
// therefore still loads on older systems, where the entry points report
// unavailable. (Compiling with `-target …macos26` instead would produce
// strong binds that abort dyld on pre-26 macOS.)

import Foundation
import AVFoundation
import CoreMedia
#if canImport(Speech)
import Speech
#endif

// ─── Async-to-sync shim ──────────────────────────────────────────────────────

/// Run an async closure to completion on the caller's thread. Rust always
/// invokes these entry points from a `spawn_blocking` worker so blocking is
/// fine (same shim as AppleAI.swift).
private func runBlocking<T>(_ work: @escaping () async -> T) -> T {
    let semaphore = DispatchSemaphore(value: 0)
    var box: T?
    Task.detached {
        let value = await work()
        box = value
        semaphore.signal()
    }
    semaphore.wait()
    return box!
}

// ─── Availability ────────────────────────────────────────────────────────────

@_cdecl("mn_speech_available")
public func mn_speech_available() -> Bool {
    #if canImport(Speech)
    if #available(macOS 26, *) {
        guard SpeechTranscriber.isAvailable else { return false }
        return runBlocking {
            // "Available" means a transcription locale asset is actually on
            // disk — the engine is then genuinely zero-download. (A missing
            // asset for the *selected* language is still auto-installed at
            // transcription time via AssetInventory.)
            let installed = await SpeechTranscriber.installedLocales
            return !installed.isEmpty
        }
    }
    #endif
    return false
}

// ─── Transcription ───────────────────────────────────────────────────────────

public typealias MNSpeechCallback = @convention(c) (UnsafePointer<CChar>?, UnsafeMutableRawPointer?) -> Void

/// Transcribe the 16kHz mono WAV at `pathPtr`. `localePtr` carries the app's
/// transcription-language setting ("auto"/"" = system locale, else a BCP-47
/// or two-letter code like "en" / "fr"). Returns 0 on success; negative on
/// failure. The callback fires exactly once either way (segments JSON on
/// success, {"__error": …} on failure).
@_cdecl("mn_speech_transcribe_file")
public func mn_speech_transcribe_file(
    _ pathPtr: UnsafePointer<CChar>,
    _ localePtr: UnsafePointer<CChar>?,
    _ callback: MNSpeechCallback,
    _ userData: UnsafeMutableRawPointer?
) -> Int32 {
    let path = String(cString: pathPtr)
    let localeId = localePtr.map { String(cString: $0) } ?? ""

    var code: Int32 = -1
    var payload = "{\"__error\":\"Apple Speech transcription requires macOS 26 or later\"}"
    #if canImport(Speech)
    if #available(macOS 26, *) {
        (code, payload) = runBlocking { await transcribeFile(path: path, localeId: localeId) }
    }
    #endif
    payload.withCString { callback($0, userData) }
    return code
}

#if canImport(Speech)

private struct MNSegment: Codable {
    let text: String
    let start_ms: UInt64
    let end_ms: UInt64
}

private func errorJSON(_ message: String) -> String {
    let envelope = ["__error": message]
    if let data = try? JSONEncoder().encode(envelope),
       let s = String(data: data, encoding: .utf8) {
        return s
    }
    return "{\"__error\":\"Apple Speech failed\"}"
}

private struct MNSpeechError: Error, CustomStringConvertible {
    let description: String
}

/// Resolve the app's language setting ("auto"/"" = system locale, else a
/// code like "en" or "fr") to a supported transcription locale. A bare
/// language code prefers the user's region variant (es + US → es_US) before
/// falling back to whatever variant the framework picks.
@available(macOS 26, *)
private func resolveLocale(_ localeId: String) async -> Locale? {
    if localeId.isEmpty || localeId == "auto" {
        return await SpeechTranscriber.supportedLocale(equivalentTo: Locale.current)
    }
    if !localeId.contains("_") && !localeId.contains("-"),
       let region = Locale.current.region?.identifier {
        let regional = Locale(identifier: "\(localeId)_\(region)")
        if let match = await SpeechTranscriber.supportedLocale(equivalentTo: regional) {
            return match
        }
    }
    return await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: localeId))
}

@available(macOS 26, *)
private func transcribeFile(path: String, localeId: String) async -> (Int32, String) {
    guard SpeechTranscriber.isAvailable else {
        return (-1, errorJSON("Apple Speech transcription is not supported on this Mac"))
    }

    guard let locale = await resolveLocale(localeId) else {
        return (-3, errorJSON("Apple Speech does not support the language '\(localeId)'"))
    }

    do {
        // Finals only (no volatile results), each carrying its audio time
        // range — the FULL-file path wants timestamped segments, not a
        // progressive stream.
        let transcriber = SpeechTranscriber(
            locale: locale,
            transcriptionOptions: [],
            reportingOptions: [],
            attributeOptions: [.audioTimeRange]
        )

        // Only request an install when the locale asset is genuinely absent:
        // AssetInventory hands back a request object even for installed
        // locales (per-app bookkeeping), and running it can stall — measured
        // on macOS 26.3, progress pinned at 0 — while transcription works
        // fine without it whenever the asset is already on disk.
        let installed = await SpeechTranscriber.installedLocales
        let wanted = locale.identifier(.bcp47)
        if !installed.contains(where: { $0.identifier(.bcp47) == wanted }) {
            if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
                // Watchdog: never let an OS asset download wedge a
                // transcription job forever.
                try await withThrowingTaskGroup(of: Void.self) { group in
                    group.addTask { try await request.downloadAndInstall() }
                    group.addTask {
                        try await Task.sleep(for: .seconds(300))
                        throw MNSpeechError(description: "timed out downloading the speech model for \(wanted)")
                    }
                    defer { group.cancelAll() }
                    try await group.next()
                }
            }
        }

        let analyzer = SpeechAnalyzer(modules: [transcriber])
        let audioFile = try AVAudioFile(forReading: URL(fileURLWithPath: path))

        // Drain results concurrently with analysis; buffer the whole thing
        // (v1: one callback at the end — simplicity over streaming).
        let collector = Task {
            var segments: [MNSegment] = []
            for try await result in transcriber.results where result.isFinal {
                let text = String(result.text.characters)
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                if text.isEmpty { continue }
                let startSec = result.range.start.seconds
                let endSec = result.range.end.seconds
                let startMs = startSec.isFinite ? UInt64(max(0, startSec) * 1000.0) : 0
                let endMs = endSec.isFinite ? max(UInt64(max(0, endSec) * 1000.0), startMs) : startMs
                segments.append(MNSegment(text: text, start_ms: startMs, end_ms: endMs))
            }
            return segments
        }

        if let lastSample = try await analyzer.analyzeSequence(from: audioFile) {
            try await analyzer.finalizeAndFinish(through: lastSample)
        } else {
            await analyzer.cancelAndFinishNow()
        }

        let segments = try await collector.value
        let data = try JSONEncoder().encode(segments)
        return (0, String(data: data, encoding: .utf8) ?? "[]")
    } catch {
        return (-5, errorJSON("Apple Speech transcription failed: \(error.localizedDescription)"))
    }
}

#endif
