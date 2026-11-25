# Moving the port to Bun 1.4.5

Class **Port**. `scripts/sync-bun.sh` pins `oven-sh/bun` at
`a7733435cf40429e3b35c36072769df2052b80f1`, the `bun-v1.4.5` tag. The pin before
was `9510e74152073d850a18758ca41114d8f214ffa6`, a development commit between
1.4.3 and 1.4.4. `bun --version`, `Bun.version` and `process.versions.bun` read
`vendor/bun/package.json` at build time and now report 1.4.5.

## The patch series

The series was rebased onto the tag as commits and exported again. A fresh
clone with the exported patches gives the same patched commit.

| Patches | State | What changed |
| --- | --- | --- |
| 0002 to 0007, 0009, 0010, 0012 to 0018, 0020 to 0027 | Same change | Only hunk positions and context moved. |
| [0001](0001-platform-selection-and-pointer-layout.md) | Adjusted | WASI stays out of the new signal re-raise path; the interim 32-bit string tags lose the removed "global" bit. |
| 0008 | Adjusted | The `finally` handler hook takes upstream's new `body_loc`. |
| [0011](0011-lint-layout-assertions.md) | Smaller | The `TypeArguments` size hunk is gone: upstream's assertion holds on wasm32 now. |
| [0019](0019-wasm32-string-flags.md) | Rewritten | Two string flags instead of three, after upstream removed the "global" flag. |
| [0028](0028-generic-argument-serials.md) | New | A 32-bit shift overflow in the type checker that 1.4.5 introduced. |

## Adapters that follow upstream

Each owning record has the detail.

| Source | Upstream change | Local change |
| --- | --- | --- |
| `crates/bunwasm-semver`, `crates/bunwasm-bun-jsc` ([record](portable-semver-host-functions.md)) | `Bun.semver` moved to Bun's bindgen. | The facade gains `bindgen::JsHeap` and `bindgen::Result`; the crate holds the two entry points Bun generates. |
| `crates/bunwasm-build/src/dev_server` ([record](bake-graph-adaptations.md)) | The dev server was split into modules; the graph gained client page files, per-trace failures and a graph tag on failures. | The facade mirrors the new names and shapes. |
| `crates/bunwasm-build/src/stubs.rs` | The bundler calls a new plugin hook, `JSBundlerPlugin__freezeFilters`. | A stub like the other plugin hooks: plugins need JavaScriptCore. |
| `crates/bunwasm-tools/src/lint_command.rs` ([record](lint-and-format-commands.md)) | The lint driver renamed its option and bunfig functions. | The same calls under the new names. |
| `crates/bunwasm-runtime/generated/builtins/` ([record](bun-generated-builtins.md)) | Registry format 2, a required `--webkit-version`, and new module ids. | Regenerated; the generator reads format 2 and passes Bun's WebKit version. |
| `crates/bunwasm-runtime/data/tls-roots.der` ([record](guest-tls-roots.md)) | Three roots were removed. | Re-imported: 118 roots. |
| `scripts/check-encoded-slice.ts`, `tests/encoded-slice/probe.rs` ([record](0019-wasm32-string-flags.md)) | The "global" string flag and `String::borrow_utf16` are gone. | The probe covers the two remaining flags. |
| `crates/bunwasm-runtime/src/natives.rs`, `bun_string_round_trip` | `String::borrow_utf16` is gone. | The test helper wraps each encoding in a `StringView`. |
| `crates/bunwasm-lint-native/build.rs` ([record](lint-and-format-commands.md)) | A JSON lint rule normalizes keys through a new ICU binding. | An NFC and NFD version of that binding, which keeps 8.1 MB of ICU data out of the tools guest. |
| `scripts/sync-bun.sh` | `rust-argon2` has a second patch. | The script applies every patch Bun lists for it. |

## What did not move

- **WebKit.** `jsc/common.sh` stays at `3d3257150c40a1aabdc5f8b48d5b33d0413674cb`.
  Bun 1.4.5 pins `d6375c72affe0f70222cdcb45012b10f0bf3a9d5`. On that commit
  five hunks of `jsc/webkit-wasi.patch` no longer apply, in
  `heap/Collector.cpp` and `heap/Heap.cpp` (one collector now serves several
  heaps), `bytecompiler/NodesCodegen.cpp` (the block and `if` emitters that the
  [statement spine](jsc-statement-spine.md) replaces changed) and
  `yarr/YarrInterpreter.cpp`, and hunks that still apply call the old
  single-heap collector (`Collector::requestCollection(request)`). bun-wasm does not compile Bun's C++ bindings
  against JavaScriptCore, apart from the two files `bunwasm-lint-native`
  extracts, so the engine version and the Bun source version are independent.
- **BoringSSL.** `scripts/sync-crypto.sh` stays at
  `41bf9b59c2ebf277a7aa427e1ecad5cc80dd4d4f`. Bun 1.4.5 pins
  `fe703e9faa3bfd22b04eb192066856557b7e015c`.
- **Other records.** Records of adapted implementations that name
  `9510e74152073d850a18758ca41114d8f214ffa6` say which revision the adaptation
  was compared with. They were not compared again at 1.4.5.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`scripts/sync-bun.sh`, `patches/bun/`](#moving-the-port-to-bun-145) | Port | Rebase the patch series onto the `bun-v1.4.5` tag. |

[Parent context](bun-patch-series.md).

[Ledger scope and pinned revisions](scope.md).
