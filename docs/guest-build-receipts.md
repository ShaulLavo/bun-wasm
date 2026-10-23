# Guest build receipts

The four guest build entry points check their source before compilation and write
`dist/<guest>.wasm.build.json` beside the final optimized artifact. The sidecar binds
an allowlisted source-input manifest to the guest's uncompressed SHA-256 and byte
count. It is not a full dependency closure, signature, or proof of build execution.

## Recorded inputs

`GuestBuildReceipt` in `scripts/guest-build-receipt.ts` retains `bunHead`, `bunTree`,
`sysrootReceiptSha256`, `artifactSha256`, and `artifactBytes`. It adds these fields:

- `sourceManifestSha256` hashes `JSON.stringify(sourceManifest)` in UTF-8.
- `sourceManifest.schema` is `1`.
- `sourceManifest.build` selects `browser`, `quickjs`, `quickjs-minimal`, `jsc`, or
  `tools`. These map to the existing entry points and feature choices in
  `scripts/guest-source-manifest.ts`. The target is `wasm32-wasip1`, release mode.
- `sourceManifest.source.head` and `.tree` identify the committed repository.
- `sourceManifest.groups` contains named file inventories. Each entry records the
  relative path, SHA-256, and byte count of the bytes read from disk.
- `sourceManifest.tools` records resolved executable paths, executable hashes, and
  version output. Rust tools resolve through the checkout's active Rustup toolchain.
- `sourceManifest.omissions` states what the inventory does not establish.

The explicit groups cover these inputs:

- `repository`. Committed files under `crates`, `third_party`, `scripts`, `patches`,
  `jsc`, and `.cargo`, plus Cargo manifests/lockfile, Rust toolchain, `env.sh`,
  `package.json`, and `bun.lock`. Working bytes must match each committed Git blob,
  including when Git's `assume-unchanged` flag hides an edit from status.
- `bun`. Imported `src`, Cargo manifests/lockfile, generated `build/debug/codegen`,
  and the installed lol-html and rust-argon2 trees. `sync-bun.sh --check` still
  requires the committed Bun tree to match the pinned source and patch series.
- `boringssl`. The selected source's CMake inputs, headers, crypto, generated code,
  third-party sources, and utility sources. Tools-only builds do not consume it.
- `waffle-libc`. The installed package metadata, libc builder, and preopen patch.
- `sysroot`. The existing sysroot receipt and actual `include` and `lib` contents,
  including SDK overlays. The top-level receipt hash must match this inventory.
  Its builder, patch, SDK version, and libc hashes must match the installed bytes.
- `sdk`. SDK version and Clang resource files. SDK compiler, archiver, linker,
  Rust compiler/Cargo, Bun, CMake, Ninja, and optimizer identities are recorded.
  Rust target-library bytes have their own `rust-target` group.
- `jsc-prebuild`. JSC and tools builds also inventory the existing input stamp,
  compiler database, copied toolchain/shim inputs, and linked archives. The JSC
  embedding receipt remains separate.

Groups are bounded source/config supersets, not compiler-observed dependency lists.
Cargo registry/git cache bytes, ambient environment, user/global Cargo configuration,
host shared libraries, intermediate-cache provenance, and full WebKit/ICU header
and prebuild source closure are known omissions. The Waffle browser runtime is not
compiled into the guest. Only its libc inputs belong to this manifest.

## Build and publication rules

Repository source must be committed and clean. Dirty or inconsistent source is
rejected; these entry points do not offer a synthetic-source mode. Synthetic test
receipts are explicitly labeled and prove only the utility behavior.

The build stores its start snapshot in a temporary file, not a large command-line
argument. All source inventories and tool identities must match at build end.
The temporary file is removed on success, failure, or interruption. The artifact
name must match the selected build. Hashes cover final uncompressed Wasm, not Cargo
intermediates or gzip transfer bytes.

No receipt is inferred or upgraded for an existing artifact. Historical hash-only
receipts are rejected by the current publication gate. Rebuild through the normal
entry point after selecting the intended committed source.

Publication preserves this sidecar in its private artifact snapshot and acceptance
log. Engine labels must match artifact names. Browser acceptance, immutable storage
checks, public readback, and descriptor generation remain separate gates. A later
source merge or descriptor commit does not change previously published guest bytes.
The old public `e63f4b4f...` guest has not been rebuilt or republished by this change.
