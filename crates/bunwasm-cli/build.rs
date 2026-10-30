//! Link settings for bun.wasm.
fn main() {
    println!("cargo:rerun-if-env-changed=BUN_WASM_SYSROOT");
    println!("cargo:rerun-if-env-changed=BUN_WASM_PROGRAM_PROFILE");
    let target = std::env::var("TARGET").unwrap_or_default();
    if !target.starts_with("wasm32") {
        return;
    }
    memory_telemetry();
    if shared_group() {
        shared_group_link();
    } else {
        // Bun's parser recurses deeply: 8 MiB of stack.
        println!("cargo:rustc-link-arg-bin=bun=-zstack-size=8388608");
        // Bun's string pointer tags use the top three address bits on wasm32, so
        // linear memory must stay below 512 MiB.
        println!("cargo:rustc-link-arg-bin=bun=--max-memory=536870912");
        // The bun_wasm host ABI (docs/host-abi.md): hosts install networking
        // functions into the exported, growable table and record their indices
        // in the slots `bun_wasm_host_slots` points at.
        println!("cargo:rustc-link-arg-bin=bun=--export-table");
        println!("cargo:rustc-link-arg-bin=bun=--growable-table");
    }
    println!("cargo:rustc-link-arg-bin=bun=--export=bun_wasm_host_slots");
    // Host-engine build: the exports web/src/engine-host.js calls.
    if std::env::var_os("CARGO_FEATURE_ENGINE_HOST").is_some() {
        for name in [
            "bunwasm_ready",
            "bunwasm_alloc",
            "bunwasm_call",
            "bunwasm_describe",
            "bunwasm_result_ptr",
            "bunwasm_result_len",
        ] {
            println!("cargo:rustc-link-arg-bin=bun=--export={name}");
        }
    }
    if std::env::var_os("CARGO_FEATURE_ENGINE_SPLIT").is_some() {
        split_entry();
        return;
    }
    // BoringSSL, JavaScriptCore and Rust share Waffle's patched wasi-libc.
    {
        let sysroot = std::env::var("BUN_WASM_SYSROOT").expect("BUN_WASM_SYSROOT (source env.sh)");
        println!("cargo:rustc-link-arg-bin=bun={sysroot}/lib/wasm32-wasip1/crt1-command.o");
    }
}

/// The opt-in memory-group member profile (docs/shared-group-profile.md). Any other value fails.
fn shared_group() -> bool {
    match std::env::var("BUN_WASM_PROGRAM_PROFILE").as_deref() {
        Err(_) => false,
        Ok("shared-group") => true,
        Ok(other) => panic!("unsupported BUN_WASM_PROGRAM_PROFILE {other}"),
    }
}

/// A PIE member image: the host supplies its memory, table, bases and stack, and the
/// 512 MiB string-tag ceiling becomes the declared maximum of the imported group memory.
fn shared_group_link() {
    assert!(
        std::env::var_os("CARGO_FEATURE_ENGINE_SPLIT").is_some(),
        "shared-group is an engine-split core profile"
    );
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let list = root.join("shared-group-link.txt");
    println!("cargo:rerun-if-changed={}", list.display());
    for arg in std::fs::read_to_string(list).unwrap().lines() {
        println!("cargo:rustc-link-arg-bin=bun={arg}");
    }
    // The producer proves which C++ runtime members the link selected from this map.
    println!("cargo:rerun-if-env-changed=BUN_WASM_CORE_LINK_MAP");
    let map = std::env::var("BUN_WASM_CORE_LINK_MAP")
        .expect("shared-group cores record their link map in BUN_WASM_CORE_LINK_MAP");
    println!("cargo:rustc-link-arg-bin=bun=-Map={map}");
    shared_cxx_runtime();
}

/// A loaded object's definitions keep every SDK libc++/libc++abi member out of the link
/// (cxx-runtime.c explains why none of them qualify for shared memory).
fn shared_cxx_runtime() {
    let source = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("cxx-runtime.c");
    let object = std::path::Path::new(&std::env::var("OUT_DIR").unwrap()).join("cxx-runtime.o");
    let compiler = std::env::var("CC_wasm32_wasip1").expect("source env.sh");
    let sysroot = std::env::var("BUN_WASM_SYSROOT").expect("source env.sh");
    let status = std::process::Command::new(compiler)
        .args([
            "--target=wasm32-wasip1",
            &format!("--sysroot={sysroot}"),
            "-O2",
            "-c",
        ])
        .args(entry_flags())
        .arg(&source)
        .arg("-o")
        .arg(&object)
        .status()
        .unwrap();
    assert!(
        status.success(),
        "compile shared-group C++ runtime overrides"
    );
    println!("cargo:rerun-if-changed={}", source.display());
    println!("cargo:rustc-link-arg-bin=bun={}", object.display());
}

fn split_entry() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let exports = root.join("scripts/quickjs-core-exports.txt");
    let source = root.join("crates/bunwasm-cli/entry-split.c");
    let object = std::path::Path::new(&std::env::var("OUT_DIR").unwrap()).join("entry-split.o");
    let compiler = std::env::var("CC_wasm32_wasip1").expect("source env.sh");
    let sysroot = std::env::var("BUN_WASM_SYSROOT").expect("source env.sh");
    assert!(
        std::process::Command::new(compiler)
            .args([
                "--target=wasm32-wasip1",
                &format!("--sysroot={sysroot}"),
                "-O2",
                "-c"
            ])
            .args(entry_flags())
            .arg(&source)
            .arg("-o")
            .arg(&object)
            .status()
            .unwrap()
            .success()
    );
    println!("cargo:rerun-if-changed={}", source.display());
    println!("cargo:rerun-if-changed={}", exports.display());
    println!("cargo:rustc-link-arg-bin=bun={}", object.display());
    // `clock` and `getrusage` for engine sides: their emulation keeps state (its start time), so
    // the core owns it. Side programs cannot link libc members, which are not PIC.
    println!(
        "cargo:rustc-link-arg-bin=bun={sysroot}/lib/wasm32-wasip1/libwasi-emulated-process-clocks.a"
    );
    for name in std::fs::read_to_string(exports).unwrap().lines() {
        // A PIE member imports its stack pointer; the side shares that same imported global.
        // Its stack and heap are carved by the host, so wasm-ld defines no stack bounds or heap
        // base for it. Only JSC and Hermes sides import those, and neither is shared-group qualified.
        if shared_group() && GROUP_UNEXPORTED.contains(&name) {
            continue;
        }
        println!("cargo:rustc-link-arg-bin=bun=--export={name}");
    }
    if shared_group() {
        for name in GROUP_MEMORY_EXPORTS {
            println!("cargo:rustc-link-arg-bin=bun=--export={name}");
        }
    }
}

/// Core exports a PIE member does not have or must not offer. The host supplies its stack and
/// heap, so wasm-ld defines no layout symbols. Its `errno` is thread-local, so the export would be
/// a TLS offset that a side's `GOT.mem.errno` would misread as an address; the QuickJS side has
/// its own errno (crates/bunwasm-engine-quickjs/group-errno.c).
const GROUP_UNEXPORTED: [&str; 5] = [
    "__stack_pointer",
    "__stack_low",
    "__stack_high",
    "__heap_base",
    "errno",
];

/// The core's memory-group service for its engine side (bunwasm-runtime `group_memory`).
const GROUP_MEMORY_EXPORTS: [&str; 12] = [
    "bun_shm_create",
    "bun_shm_retain",
    "bun_shm_release",
    "bun_shm_pin",
    "bun_shm_route",
    "bun_shm_unpin",
    "bun_shm_accept",
    "bun_futex_wait32",
    "bun_futex_wait64",
    "bun_futex_wake",
    "bun_futex_watch",
    "bun_futex_unwatch",
];

fn memory_telemetry() {
    let source = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("memory-telemetry.c");
    let object =
        std::path::Path::new(&std::env::var("OUT_DIR").unwrap()).join("memory-telemetry.o");
    let compiler = std::env::var("CC_wasm32_wasip1").expect("source env.sh");
    let sysroot = std::env::var("BUN_WASM_SYSROOT").expect("source env.sh");
    let status = std::process::Command::new(compiler)
        .args([
            "--target=wasm32-wasip1",
            &format!("--sysroot={sysroot}"),
            "-O2",
            "-fno-builtin",
            "-c",
        ])
        .args(entry_flags())
        .arg(&source)
        .arg("-o")
        .arg(&object)
        .status()
        .unwrap();
    assert!(status.success(), "compile memory telemetry");
    println!("cargo:rerun-if-changed={}", source.display());
    println!("cargo:rustc-link-arg-bin=bun={}", object.display());
    for name in [
        "malloc",
        "calloc",
        "realloc",
        "free",
        "aligned_alloc",
        "posix_memalign",
        "__libc_malloc",
        "__libc_calloc",
        "__libc_free",
    ] {
        println!("cargo:rustc-link-arg-bin=bun=--wrap={name}");
    }
    println!("cargo:rustc-link-arg-bin=bun=--export=bun_memory_telemetry");
}

/// Both C objects join the core link, so shared-group needs them PIC with atomics.
fn entry_flags() -> &'static [&'static str] {
    if shared_group() {
        &["-fPIC", "-matomics", "-mbulk-memory", "-mmutable-globals"]
    } else {
        &[]
    }
}
