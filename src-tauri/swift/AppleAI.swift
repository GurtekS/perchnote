// AppleAI.swift
//
// Bridge to Apple's on-device FoundationModels framework (macOS 26+).
// Exposes three C-callable entry points used by `apple_ai.rs`:
//
//   mn_apple_ai_available()       -> Bool
//   mn_apple_ai_generate_notes(_) -> char* (JSON encoded GeneratedNotes)
//   mn_apple_ai_rediarize(_)      -> char* (JSON encoded {assignments:[…]})
//   mn_apple_ai_chat(_)           -> char* (plain text)
//   mn_apple_ai_free(_)           -> void  (free a returned C string)
//
// The framework is only present on macOS 26+. All references are wrapped in
// `if #available(macOS 26.0, *)` so the binary still links on older targets.
// On older OSes the entry points return null / false.

import Foundation

#if canImport(FoundationModels)
import FoundationModels
#endif

// ─── @Generable schemas ──────────────────────────────────────────────────────

#if canImport(FoundationModels)

@available(macOS 26.0, *)
@Generable
struct GenActionItem: Codable {
    @Guide(description: "What needs to be done")
    let task: String

    @Guide(description: "Who is responsible, or null if unclear")
    let assignee: String?

    @Guide(description: "Mentioned deadline, or null if not stated")
    let deadline: String?

    @Guide(description: "Start of the transcript line this item came from, in milliseconds: convert its [m:ss] stamp as (m*60+ss)*1000. Null if unsure.")
    let source_start_ms: Int?
}

@available(macOS 26.0, *)
@Generable
struct GenNoteSection: Codable {
    @Guide(description: "Section heading, e.g. Summary or Action Items")
    let heading: String

    @Guide(description: "Bullet points under this heading")
    let bullets: [String]
}

@available(macOS 26.0, *)
@Generable
struct GenNotes: Codable {
    @Guide(description: "A short title for the meeting")
    let title: String

    @Guide(description: "A concise paragraph summarising what happened")
    let summary: String

    @Guide(description: "Sections of meeting notes")
    let sections: [GenNoteSection]

    @Guide(description: "Action items extracted from the meeting")
    let action_items: [GenActionItem]

    @Guide(description: "Two to three short categorisation tags for the meeting")
    let tags: [String]
}

@available(macOS 26.0, *)
@Generable
struct GenAssignment: Codable {
    @Guide(description: "Segment index this assignment refers to")
    let index: Int

    @Guide(description: "Speaker label such as 'Speaker 1'")
    let speaker: String
}

@available(macOS 26.0, *)
@Generable
struct GenDiarization: Codable {
    @Guide(description: "Per-segment speaker assignments")
    let assignments: [GenAssignment]
}

#endif

// ─── C-string lifecycle helpers ──────────────────────────────────────────────

private func toCString(_ s: String) -> UnsafeMutablePointer<CChar>? {
    let utf8 = Array(s.utf8)
    let buf = UnsafeMutablePointer<CChar>.allocate(capacity: utf8.count + 1)
    for (i, byte) in utf8.enumerated() {
        buf[i] = CChar(bitPattern: byte)
    }
    buf[utf8.count] = 0
    return buf
}

@_cdecl("mn_apple_ai_free")
public func mn_apple_ai_free(_ p: UnsafeMutablePointer<CChar>?) {
    p?.deallocate()
}

// ─── Availability ────────────────────────────────────────────────────────────

@_cdecl("mn_apple_ai_available")
public func mn_apple_ai_available() -> Bool {
    #if canImport(FoundationModels)
    if #available(macOS 26.0, *) {
        let availability = SystemLanguageModel.default.availability
        if case .available = availability {
            return true
        }
    }
    #endif
    return false
}

// ─── Generation primitives ───────────────────────────────────────────────────

/// Run an async closure to completion on the caller's thread. Rust always
/// invokes these entry points from a `spawn_blocking` worker so blocking is
/// fine.
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

@_cdecl("mn_apple_ai_generate_notes")
public func mn_apple_ai_generate_notes(_ promptPtr: UnsafePointer<CChar>) -> UnsafeMutablePointer<CChar>? {
    let prompt = String(cString: promptPtr)
    #if canImport(FoundationModels)
    if #available(macOS 26.0, *) {
        let payload: String = runBlocking {
            do {
                let session = LanguageModelSession()
                let response = try await session.respond(to: prompt, generating: GenNotes.self)
                let data = try JSONEncoder().encode(response.content)
                return String(data: data, encoding: .utf8) ?? ""
            } catch {
                let err = "{\"__error\":\"\(escape(error.localizedDescription))\"}"
                return err
            }
        }
        return toCString(payload)
    }
    #endif
    return nil
}

@_cdecl("mn_apple_ai_rediarize")
public func mn_apple_ai_rediarize(_ promptPtr: UnsafePointer<CChar>) -> UnsafeMutablePointer<CChar>? {
    let prompt = String(cString: promptPtr)
    #if canImport(FoundationModels)
    if #available(macOS 26.0, *) {
        let payload: String = runBlocking {
            do {
                let session = LanguageModelSession()
                let response = try await session.respond(to: prompt, generating: GenDiarization.self)
                let data = try JSONEncoder().encode(response.content)
                return String(data: data, encoding: .utf8) ?? ""
            } catch {
                return "{\"__error\":\"\(escape(error.localizedDescription))\"}"
            }
        }
        return toCString(payload)
    }
    #endif
    return nil
}

@_cdecl("mn_apple_ai_chat")
public func mn_apple_ai_chat(_ promptPtr: UnsafePointer<CChar>) -> UnsafeMutablePointer<CChar>? {
    let prompt = String(cString: promptPtr)
    #if canImport(FoundationModels)
    if #available(macOS 26.0, *) {
        let payload: String = runBlocking {
            do {
                let session = LanguageModelSession()
                let response = try await session.respond(to: prompt)
                return response.content
            } catch {
                return "__error:" + error.localizedDescription
            }
        }
        return toCString(payload)
    }
    #endif
    return nil
}

private func escape(_ s: String) -> String {
    s.replacingOccurrences(of: "\\", with: "\\\\")
     .replacingOccurrences(of: "\"", with: "\\\"")
     .replacingOccurrences(of: "\n", with: "\\n")
}
