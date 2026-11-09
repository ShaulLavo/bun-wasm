# Rust compiler cache

Class **Host feature**. The compiler dispatcher and regression fixture are original
build adapters. They do not copy upstream implementation code.

`scripts/rustc-cache.sh` sends Rust `staticlib` compilations directly to rustc.
Other crate types still use the pinned sccache 0.19.0. Both the optional build-cache
wrapper and the qualified guest environment select this dispatcher. Guest source
manifests include its bytes, while tool inventories retain the sccache executable
and version.

In mozilla/sccache tag `v0.19.0`, `src/compiler/rust.rs` hashes direct `--extern`
files and explicitly named native archives. A Rust staticlib also bundles code
from transitive dependencies. Changing a native archive can change the leaf
Rust archive without changing the intermediate Rust archive. sccache then restores
an old staticlib because its direct inputs still match. Cargo correctly requests
recompilation, but that request alone does not prevent the stale cache hit.

The dispatcher avoids that incomplete cache key rather than inventing a separate
transitive dependency scanner or forcing every Rust compilation to recache. It
also bypasses sccache when a crate requests `staticlib` together with another crate
type. No engine semantics, native source, receipt assertions, or cache contents
change.

`scripts/rust-native-cache.test.ts` builds a dependency-free Cargo fixture through
the real guest compiler environment and the normal build-cache entrypoint. Its
C archive sits behind two Rust dependencies. After changing only C, a linked
executable must print the new value. An unchanged build must stay fresh, and
rebuilding after deleting only the fixture's target must reuse cached Rust
objects and produce the same staticlib bytes. Each case owns its temporary target,
disk cache, and cache server, and stops that server before removing its files.

Run the focused check with the pinned sccache, a host C compiler, and Rust installed:

```sh
source env.sh
bun test scripts/rust-native-cache.test.ts
```

## Already stale private targets

Changing `RUSTC_WRAPPER` alone does not invalidate a target that Cargo already
considers fresh. The regression prevents new bad cache hits. It does not repair
previously poisoned output files. For a known affected private QuickJS target,
clean only `bunwasm-engine-quickjs` in that target and remove its derived
`engine.wasm`, `engine.wasm.engine.json`, and `engine.implicit.wasm` before rebuilding.
Do not clear the disk object cache. The dispatcher rebuilds the final staticlib
without `SCCACHE_RECACHE=1` and still reuses valid dependency objects.
