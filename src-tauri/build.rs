fn main() {
    tauri_build::build();

    // On macOS, compile our Swift helpers and link them into the Rust binary.
    #[cfg(target_os = "macos")]
    {
        compile_swift_helper(SwiftHelper {
            src: "swift/ProcessAudioTap.swift",
            module: "MNProcessAudioTap",
            lib_basename: "mnprocessaudiotap",
            frameworks: &["CoreAudio", "AVFAudio", "CoreGraphics"],
            // CATapDescription needs macOS 14.2.
            target_macos: "14.2",
        });
        compile_swift_helper(SwiftHelper {
            src: "swift/VoiceProcessedMic.swift",
            module: "MNVoiceProcessedMic",
            lib_basename: "mnvoiceprocessedmic",
            // AVAudioEngine + the voice-processing I/O unit live in AVFAudio.
            frameworks: &["AVFAudio"],
            // The ducking-config API (used unguarded) needs macOS 14.0;
            // match the app's existing 14.2 floor.
            target_macos: "14.2",
        });
        compile_swift_helper(SwiftHelper {
            src: "swift/SpeechEngine.swift",
            module: "MNSpeechEngine",
            lib_basename: "mnspeechengine",
            // SpeechAnalyzer/SpeechTranscriber (Speech) + AVAudioFile
            // (AVFAudio) + CMTime (CoreMedia). The frameworks themselves
            // predate macOS 26; only the SpeechTranscriber symbols are new.
            frameworks: &["Speech", "AVFAudio", "CoreMedia"],
            // Deliberately the app's 14.2 floor, NOT 26: compiling against
            // the older target makes swiftc enforce the @available(macOS 26)
            // guards AND emit the 26-only Speech symbols as weak imports, so
            // the binary still loads on pre-26 systems (where the entry
            // points report unavailable). Targeting 26 here would produce
            // strong binds that abort dyld on older macOS.
            target_macos: "14.2",
        });
        compile_swift_helper(SwiftHelper {
            src: "swift/EmbeddingEngine.swift",
            module: "MNEmbeddingEngine",
            lib_basename: "mnembeddingengine",
            // NLContextualEmbedding lives in NaturalLanguage (macOS 14.0+) —
            // at the app's 14.2 floor it links strongly; no weak-import
            // gymnastics needed (those were only for 26-only symbols).
            frameworks: &["NaturalLanguage"],
            target_macos: "14.2",
        });
        compile_swift_helper(SwiftHelper {
            src: "swift/AppleAI.swift",
            module: "MNAppleAI",
            lib_basename: "mnappleai",
            // FoundationModels symbols are weak-linked; on older macOS the
            // file compiles to no-op stubs, so no extra framework deps.
            frameworks: &["FoundationModels"],
            // FoundationModels needs macOS 26+. We target it explicitly here;
            // the @available guards inside the Swift code mean the call sites
            // are still safe (Swift's runtime gates them).
            target_macos: "26.0",
        });

        emit_swift_stdlib_rpath();
    }
}

#[cfg(target_os = "macos")]
struct SwiftHelper {
    src: &'static str,
    module: &'static str,
    lib_basename: &'static str,
    frameworks: &'static [&'static str],
    target_macos: &'static str,
}

#[cfg(target_os = "macos")]
fn compile_swift_helper(h: SwiftHelper) {
    use std::process::Command;

    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap();
    let out_dir = std::env::var("OUT_DIR").unwrap();
    let swift_src = format!("{}/{}", manifest_dir, h.src);
    let obj_out = format!("{}/{}.o", out_dir, h.module);
    let lib_out = format!("{}/lib{}.a", out_dir, h.lib_basename);

    let arch = std::env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_else(|_| "arm64".to_string());
    let triple = match arch.as_str() {
        "x86_64" => format!("x86_64-apple-macos{}", h.target_macos),
        _        => format!("arm64-apple-macos{}",  h.target_macos),
    };

    let out = Command::new("swiftc")
        .args([
            &swift_src,
            "-target", &triple,
            "-parse-as-library",
            "-emit-object",
            "-module-name", h.module,
            "-o", &obj_out,
        ])
        .output()
        .expect("swiftc not found — install Xcode Command Line Tools");

    if !out.status.success() {
        eprintln!("--- swiftc stdout ---\n{}", String::from_utf8_lossy(&out.stdout));
        eprintln!("--- swiftc stderr ---\n{}", String::from_utf8_lossy(&out.stderr));
        panic!("Failed to compile {}", h.src);
    }

    let ar_out = Command::new("ar")
        .args(["rcs", &lib_out, &obj_out])
        .output()
        .expect("ar not found");
    if !ar_out.status.success() {
        panic!("ar failed: {}", String::from_utf8_lossy(&ar_out.stderr));
    }

    println!("cargo:rustc-link-search=native={}", out_dir);
    println!("cargo:rustc-link-lib=static={}", h.lib_basename);
    for fw in h.frameworks {
        println!("cargo:rustc-link-lib=framework={}", fw);
    }
    println!("cargo:rerun-if-changed={}", h.src);
}

// Emit runtime search paths for the Swift stdlib so the binary can load
// libswiftCore.dylib, libswift_Concurrency.dylib, etc. at launch.
//
// We add two paths:
//   1. `/usr/lib/swift` — the OS-shipped Swift runtime (on macOS 12+ all of
//      stdlib + concurrency live here via the dyld shared cache).
//   2. `<xcode-toolchain>/usr/lib/swift/macosx` — fallback for libs only in
//      the Xcode toolchain. Discovered via `xcrun --find swiftc` so this
//      works regardless of where Xcode is installed.
#[cfg(target_os = "macos")]
fn emit_swift_stdlib_rpath() {
    use std::process::Command;

    // Always add the system path first — it's the right answer on macOS 12+.
    println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");

    let Ok(out) = Command::new("xcrun").args(["--find", "swiftc"]).output() else { return };
    if !out.status.success() { return }
    let swiftc = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let p = std::path::PathBuf::from(&swiftc);
    let Some(toolchain) = p.parent().and_then(|p| p.parent()).and_then(|p| p.parent()) else { return };
    let stdlib = toolchain.join("usr/lib/swift/macosx");
    if stdlib.exists() {
        println!("cargo:rustc-link-arg=-Wl,-rpath,{}", stdlib.display());
    }
}
