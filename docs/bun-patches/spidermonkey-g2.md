# SpiderMonkey VM smoke adapters

Mozilla source is pinned to `a5df22d986d4b626f771b4f8885241941601c35c`.
These changes qualify only the G2 VM probe, not a Bun engine implementation.
The G1 archive and receipts remain unchanged. G2 objects and its archive have
separate names and receipts.

| Local implementation | Classification | Upstream input | Change and reason |
| --- | --- | --- | --- |
| `spidermonkey/spidermonkey-wasi.patch`, interpreter changes | Host feature | `js/src/vm/Interpreter.cpp`, `js/src/vm/PortableBaselineInterpret.cpp` | Poll the single-threaded embedder at function entry and loop safe points. Enable PBL's pending interrupt checks under `__wasi__ && BUNWASM_EMBED`, then use the engine's interrupt callback termination rather than throwing a catchable value. PBL entry and per-tier check counters prove which code executed. |
| Same patch, stack base and recursion error | Port | `js/src/util/NativeStack.cpp`, `js/public/friend/ErrorNumbers.msg` | Read the embedder's shared stack bounds instead of capturing a side-constructor frame. Keep the 64 KiB guard gap. Classify recursive exhaustion as RangeError for this embed instead of SpiderMonkey's default InternalError. |
| Same patch, crash routes | Host feature | `mfbt/Assertions.h` | Route fatal assertions and unsafe crashes, including mozalloc OOM, to the embedder's exit boundary. Preserve ordinary catchable JS allocation errors. |
| `crates/bunwasm-spidermonkey/cpp/shim.{h,cpp}` | Original adapter | Public JSAPI at the pin | Initialize one context, select the interpreter tier, root values, evaluate scripts and collect garbage. No Engine trait, loader or job queue implementation. |
| `crates/bunwasm-spidermonkey/src/glue/normalizer.rs` | Copied and adapted | `js/src/builtin/normalizer_glue/src/lib.rs` | Keep the C ABI and fallible buffer reservations. Use the repository's locked ICU 2.4 APIs. Its published crate lacks Mozilla's private Latin1 APIs, so convert Latin1 input to UTF-16 and use the existing UTF-16 normalizer. Extract the composing and decomposing paths to keep nesting shallow. |
| `crates/bunwasm-spidermonkey/src/lib.rs`, Rust hooks | Original adapter | Mozilla's `mozglue/static/rust/lib.rs` describes the required symbols | Install one panic hook and route `RustMozCrash` to the embedder. Link the registry encoding crates and normalization into the consumer's single Rust standard library; do not include `libjsrust.a`. |
| `spidermonkey/rebuild-g2.ts` | Original build adapter | G1's generated compiler database and archive object list | Recompile the exact generated object closure into separately named G2 outputs with the embed macro. Preserve G1 files, object paths and source-package Cargo transformation. Record actual commands, patch and archive identities. |
| `spidermonkey/patch-lifecycle.sh`, `spidermonkey/smoke.sh` | Original build adapter | Local G1 fetch and G2 smoke recipes | Accept pristine or already-applied embed patches. Restore only a patch applied by this smoke invocation, including on failure, and reject unrelated patch states before compilation. Record disk space for the configured G2 output filesystem, not a workstation mount. |

The G2 side example calls only the VM smoke. The native host recognizes its
`spidermonkey-g2` tag only in test builds. Normal launchers reject that tag.
The 38 additions to `scripts/quickjs-core-exports.txt` are the measured libc
import delta. The VM-only bootstrap exports those names from the existing
consumer sysroot and exercises the unchanged linked-program loader. No full Bun
runtime core, production engine kind or Engine trait implementation is claimed.
