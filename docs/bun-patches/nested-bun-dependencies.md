### Nested Bun dependencies

`scripts/sync-bun.sh` fetches Bun's pinned `oven-sh/lol-html` and `sru-systems/rust-argon2`. There are no bun-wasm edits to lol-html.

It applies Bun's own `patches/rust-argon2/legacy-low-memory.patch` to rust-argon2's `src/common.rs` and `src/context.rs`. Class **Host feature**. This inherited Bun extension accepts nonzero memory costs below `8 * lanes` and pads allocated memory, so hashes produced by Bun's legacy low-memory behavior can still verify. Without it those hashes are rejected by the dependency. This is Bun's existing application policy, not a new wasm fix or a bug in rust-argon2. The patch also updates the dependency's tests.

Bun's compiler-free `scripts/build.ts --mode=codegen --profile=debug --buildDir=build/debug --configure-only` at revision `9510e74152073d850a18758ca41114d8f214ffa6` generates its normal Rust build options and byte-class tables without selecting a native compiler, downloading SDKs, or writing a host linker override. Selecting this existing upstream mode in `sync-bun.sh` is **Port** build configuration; the upstream codegen implementation is unchanged. No build script rewrites Bun Rust source beyond the exported patch series. `scripts/wasify.py` is an editing helper, not an invoked build transformation. Its exported edits belong to the patch series above.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`scripts/sync-bun.sh`, compiler-free codegen](#nested-bun-dependencies) | Port | Generate Rust tables without configuring Bun's native compiler or linker. |
| [`vendor/bun/vendor/rust-argon2`, inherited patch](#nested-bun-dependencies) | Host feature | Preserve Bun's low-memory Argon2 hash verification behavior. |

[Parent context](bun-patch-series.md).

[Ledger scope and pinned revisions](scope.md).
