# Native filesystem errno fidelity

Classification is an original adapter correction. No upstream source is copied or patched.

`crates/bunwasm-runtime/src/natives.rs` converts Rust I/O errors into Node-style errors for all runtime engines. Raw EMFILE, ENOMEM, ENOSPC, and EAGAIN previously reached its EIO fallback. The adapter now recognizes those errors before consulting `ErrorKind`.

Input matching uses target-specific `libc` constants. WASI errno numbers differ from Linux numbers. Public output keeps the existing guest convention of negative Linux Node errno values, with Node's code names and descriptions. Existing `ErrorKind` cases, EBADF, error properties, syscall/path arguments, and unknown-error fallback remain unchanged.

`scripts/native-errno-fidelity.test.ts` compiles the exact production conversion functions with the production error types and repository libc. Its original Rust caller constructs OS errors, checks properties with and without a path, and covers all existing kind-based cases and unknown fallbacks. A native Node process constructs the corresponding errors through its internal `UVException` constructor with `--expose-internals`. The oracle checks code, host errno, syscall, and path, then compares complete messages. Host numbers are not compared to the guest's fixed errno convention.

The test is discovered by `checks/runtime-native-errno-fidelity.json`. It needs the workspace Rust toolchain and Node 24 or later. Cargo runs offline with a private target and removes that target on success or failure.

This change corrects public error reporting. It does not identify the cause of the captured Svelte browser read failures or change file I/O, syscall attribution, callbacks, providers, or HMR.
