// EmbeddingEngine.swift
//
// Bridge to Apple's NLContextualEmbedding (NaturalLanguage, macOS 14+) —
// the zero-setup embedding backend for semantic recall (plan v10 #4).
// Exposes three C-callable entry points used by `ai/apple_embed.rs`:
//
//   mn_embed_availability()   -> char* JSON {"available","dims","assetsInstalled"}
//   mn_embed_request_assets() -> Int32 (0 = installed, <0 = failure/timeout)
//   mn_embed_batch(json)      -> char* JSON [[Float]] or {"__error": …}
//   mn_embed_free(p)          -> void   (free a returned C string)
//
// NLContextualEmbedding ships with macOS 14.0; the app's floor is 14.2, so
// everything here links strongly — no weak-import dance (that was only ever
// needed for SpeechEngine's macOS-26-only SpeechTranscriber symbols).
//
// One sentence in → one vector out: `embeddingResult` yields per-token
// vectors, which we mean-pool over content tokens (stopwords excluded; see
// `meanPooledVector`) and L2-normalize. The model's `dimension` property is
// the source of truth for dims (512 for the multilingual script-based
// English model as of macOS 26) — never hardcoded.

import Foundation
import NaturalLanguage

// ─── C-string lifecycle helpers (same pattern as AppleAI.swift) ──────────────

private func toCString(_ s: String) -> UnsafeMutablePointer<CChar>? {
    let utf8 = Array(s.utf8)
    let buf = UnsafeMutablePointer<CChar>.allocate(capacity: utf8.count + 1)
    for (i, byte) in utf8.enumerated() {
        buf[i] = CChar(bitPattern: byte)
    }
    buf[utf8.count] = 0
    return buf
}

@_cdecl("mn_embed_free")
public func mn_embed_free(_ p: UnsafeMutablePointer<CChar>?) {
    p?.deallocate()
}

private func escapeJSON(_ s: String) -> String {
    s.replacingOccurrences(of: "\\", with: "\\\\")
     .replacingOccurrences(of: "\"", with: "\\\"")
     .replacingOccurrences(of: "\n", with: "\\n")
}

private struct MNEmbedError: Error, CustomStringConvertible {
    let description: String
}

// ─── Model cache ─────────────────────────────────────────────────────────────

/// Loading the model takes real time; keep one loaded instance for the
/// process. NLContextualEmbedding's thread-safety is undocumented, so the
/// lock also serializes embedding calls (index batches and search queries
/// can arrive concurrently from separate spawn_blocking workers).
private let engineLock = NSLock()
private var cachedEmbedding: NLContextualEmbedding?

/// Caller must hold `engineLock`.
private func loadedEmbedding() throws -> NLContextualEmbedding {
    if let e = cachedEmbedding { return e }
    guard let e = NLContextualEmbedding(language: .english) else {
        throw MNEmbedError(description: "NLContextualEmbedding is unavailable for English")
    }
    guard e.hasAvailableAssets else {
        throw MNEmbedError(description: "embedding model assets are not installed")
    }
    try e.load()
    cachedEmbedding = e
    return e
}

// ─── Availability ────────────────────────────────────────────────────────────

@_cdecl("mn_embed_availability")
public func mn_embed_availability() -> UnsafeMutablePointer<CChar>? {
    guard let e = NLContextualEmbedding(language: .english) else {
        return toCString("{\"available\":false,\"dims\":0,\"assetsInstalled\":false}")
    }
    return toCString(
        "{\"available\":true,\"dims\":\(e.dimension),\"assetsInstalled\":\(e.hasAvailableAssets)}"
    )
}

// ─── Asset download ──────────────────────────────────────────────────────────

/// Ask the OS to download the English embedding assets. Returns 0 when the
/// assets are installed (already or after download), negative on failure.
@_cdecl("mn_embed_request_assets")
public func mn_embed_request_assets() -> Int32 {
    guard let e = NLContextualEmbedding(language: .english) else { return -1 }
    // CRITICAL (same failure mode as SpeechEngine's AssetInventory): Apple's
    // asset APIs can hand back a request even when the assets are already on
    // disk, and running it can stall at 0% forever. Never request when the
    // assets are already present.
    if e.hasAvailableAssets { return 0 }

    let semaphore = DispatchSemaphore(value: 0)
    var ok = false
    e.requestAssets { result, _ in
        ok = (result == .available)
        semaphore.signal()
    }
    // Watchdog on the real download: never wedge the caller forever.
    if semaphore.wait(timeout: .now() + 300) == .timedOut { return -2 }
    return ok ? 0 : -3
}

// ─── Embedding ───────────────────────────────────────────────────────────────

/// Embed a JSON array of strings; returns a JSON array of f32 arrays in the
/// same order (or an {"__error": …} envelope). Each string's per-token
/// vectors are mean-pooled into one L2-normalized vector of `dimension`
/// floats. Whitespace-only inputs (no tokens) come back as zero vectors —
/// callers filter those upstream.
@_cdecl("mn_embed_batch")
public func mn_embed_batch(_ jsonPtr: UnsafePointer<CChar>) -> UnsafeMutablePointer<CChar>? {
    let json = String(cString: jsonPtr)
    guard let data = json.data(using: .utf8),
          let texts = try? JSONDecoder().decode([String].self, from: data) else {
        return toCString("{\"__error\":\"input is not a JSON array of strings\"}")
    }

    engineLock.lock()
    defer { engineLock.unlock() }
    do {
        let embedding = try loadedEmbedding()
        let dims = embedding.dimension
        var out: [[Float]] = []
        out.reserveCapacity(texts.count)
        for text in texts {
            out.append(try meanPooledVector(embedding, text: text, dims: dims))
        }
        let payload = try JSONEncoder().encode(out)
        return toCString(String(data: payload, encoding: .utf8) ?? "[]")
    } catch {
        let detail = (error as? MNEmbedError)?.description ?? error.localizedDescription
        return toCString("{\"__error\":\"\(escapeJSON(detail))\"}")
    }
}

/// English stopwords excluded from pooling. NLContextualEmbedding is a
/// token-level model with no trained sentence vector; a plain mean over all
/// tokens is dominated by function words and ranks paraphrases poorly.
/// Pooling only content tokens measured ~5× the average rel-vs-irrelevant
/// cosine margin on a small meeting-query eval (see plan v10 #4). English
/// only — matching the .english model this engine loads.
private let stopwords: Set<String> = [
    "a", "an", "the", "is", "are", "was", "were", "be", "been", "being", "am",
    "do", "does", "did", "have", "has", "had", "will", "would", "can", "could",
    "should", "shall", "may", "might", "must",
    "i", "you", "he", "she", "it", "we", "they", "me", "him", "her", "us",
    "them", "my", "your", "his", "its", "our", "their",
    "this", "that", "these", "those", "there", "here", "what", "which", "who",
    "whom", "whose", "when", "where", "why", "how",
    "and", "or", "but", "if", "then", "than", "so", "because", "as", "of",
    "at", "by", "for", "with", "about", "against", "to", "from", "in", "out",
    "on", "off", "over", "under", "up", "down", "into", "onto",
    "not", "no", "nor", "only", "own", "same", "too", "very", "just", "now",
    "also", "much", "many", "some", "any", "all",
]

private func meanPooledVector(
    _ embedding: NLContextualEmbedding, text: String, dims: Int
) throws -> [Float] {
    let result = try embedding.embeddingResult(for: text, language: .english)
    var contentSum = [Double](repeating: 0, count: dims)
    var contentCount = 0
    var allSum = [Double](repeating: 0, count: dims)
    var allCount = 0
    // Enumerate over the result's own string — its indices are the ones the
    // token ranges were built from. (Token text is lowercased only for the
    // stopword lookup; the ranges themselves index the original string.)
    result.enumerateTokenVectors(in: result.string.startIndex..<result.string.endIndex) { vector, range in
        guard vector.count == dims else { return true }
        for i in 0..<dims { allSum[i] += vector[i] }
        allCount += 1
        let token = String(result.string[range]).lowercased()
            .trimmingCharacters(in: .punctuationCharacters)
        if !stopwords.contains(token) && token.rangeOfCharacter(from: .alphanumerics) != nil {
            for i in 0..<dims { contentSum[i] += vector[i] }
            contentCount += 1
        }
        return true
    }
    // Content tokens preferred; all-stopword inputs ("how is it going") fall
    // back to the full mean; no tokens at all → zero vector (callers filter
    // those upstream).
    let (sum, count) = contentCount > 0 ? (contentSum, contentCount) : (allSum, allCount)
    guard count > 0 else {
        return [Float](repeating: 0, count: dims)
    }
    var mean = (0..<dims).map { Float(sum[$0] / Double(count)) }
    // L2-normalize so cosine distance in vec0 is well-conditioned (Ollama's
    // embeddings arrive normalized too).
    let norm = mean.reduce(Float(0)) { $0 + $1 * $1 }.squareRoot()
    if norm > 0 {
        for i in 0..<dims { mean[i] /= norm }
    }
    return mean
}
