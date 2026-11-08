# SpiderMonkey WASI build inputs

The source pin is `mozilla-firefox/firefox@a5df22d986d4b626f771b4f8885241941601c35c`.
This record covers the standalone library build only. It does not describe an
engine adapter or claim runtime correctness. The separate [G2 record](spidermonkey-g2.md) describes the VM smoke and embed-only patch.

| Local path or output | Classification | Upstream source | Local change and reason |
| --- | --- | --- | --- |
| `spidermonkey/fetch-spidermonkey.sh`, generated `firefox/Cargo.toml` | Original adapter using an upstream build transformation | `js/src/make-source-package.py`, `rsync_filter_list`, `is_mozjs_cargo_member`, `is_mozjs_crates_io_local_patch`, and `copy_cargo_toml` at the pin | Reverse the source packager's first-match filters for Git's last-match sparse rules. Include `Cargo.toml` and `CLOBBER`, which the packager handles separately. Invoke its three unmodified manifest helpers to remove browser-only workspace members and local crate patches. No copied helper implementation is checked in. |
| `spidermonkey/common.sh`, `spidermonkey/mozconfig.in`, `spidermonkey/build.sh` | Original adapter | Mozilla's `js/src/devtools/automation/variants/wasi` and `wasi-pbl` at the pin are configuration references | Use the existing consumer sysroot, wasi-sdk 34, PIC, no C++ exceptions, at most four build jobs, and lane-private build state. Compile PBL without forcing it on. Define `BUNWASM_EMBED=1` for the existing G2 stack, interrupt and fatal hooks. Do not build a shell, JIT, shared memory, or Intl. |
| `spidermonkey/check-build.ts`, `spidermonkey/native-source-closure.ts` | Original adapter | Generated `js/src/build/libjs_static_a.list` and support-directory `backend.mk` files at the pin | Pack the generated JS object list and the memory, mozalloc, mfbt, mozglue, and fmt support objects. Keep only C/C++ objects, with no Rust staticlib or sysroot archive. Check object headers, exception tags, PIC compile flags, relocations, and target identity. Hash the exported headers and build inputs. |
| `spidermonkey/spidermonkey-wasi.patch` | Host feature and port | Interpreter, PBL, native stack, assertion and error-format-table files at the pin | G1 needed no source patch. G2 adds guarded interrupt polls, embedder stack bounds, a catchable recursion RangeError and fatal routing. The G2 record classifies each change. Without `BUNWASM_EMBED`, the original WASI behavior remains. |

The support-object selection is re-derived from the pinned build's generated
source recipes. StarlingMonkey's `cmake/spidermonkey.cmake` at
`d7283bba305cffd6831bb65ab8f62500fd509c04` is prior art for packing those objects,
not a copied object list. Mozilla has no final executable link command in this
configuration because `--disable-js-shell` removes the executable target.

Mozilla's WASI variants skip all three test suites. Their completed CI tasks
establish build evidence, not runtime correctness. The PBL interrupt source is
`js/src/vm/PortableBaselineInterpret.cpp`. G2 enables its pending-interrupt checks
only for the WASI embed build. Both tiers require runtime proof before integration.

## Unicode addendum source changes

The N1 fetch installs the reviewed overlay and selected-data generated support
in a fresh source tree. The independent C0-C2 controls and known holds are described in the [Unicode adapter record](spidermonkey-irregexp-icu-subset.md).

| Patched upstream path at the same pin | Class | Change and reason |
| --- | --- | --- |
| `js/src/irregexp/moz.build` | Port | For WASI without native Intl, select the shipping `V8_INTL_SUPPORT` path and compile the ICU4X-backed subset, its checked allocator, and selected-data generated special-case support instead of the original empty supplementary table. Keep ICU headers private to irregexp. The overlay sources follow Mozilla's alphabetical `UNIFIED_SOURCES` requirement. |
| `js/src/moz.build` | Port | Generate the existing properties-glue header in the WASI no-Intl profile. The side still supplies Rust code through one staticlib, not `libjsrust.a`. |
| `js/src/irregexp/imported/regexp-parser.cc` | Port | In the subset arm, use strict alias predicates and distinguish errors from successful empty sets. Other profiles keep their original ICU4C alias enumeration and empty-set behavior. |
| `js/src/builtin/String.cpp` | Port | U3: `Final_Sigma` names its `Cased` and `Case_Ignorable` source through one alias. Intl builds alias `mozilla::intl::String` unchanged; the WASI embed build without Intl aliases a struct that calls `bunsm_ucd_is_cased` and `bunsm_ucd_is_case_ignorable` from the side's ICU4X glue, and enables the upstream context scan. Other no-Intl builds keep the plain U+03C3 mapping. |

## N1 native input custody

`spidermonkey/native-profile.ts` is an original build adapter. It installs only
the production subset headers, allocator, implementation, and generated support.
The fetch rejects old configured trees without the profile and rejects changed
profile inputs on reuse. The native receipt binds the patch, overlay, generators,
selected-data receipt, Rust glue, lockfile, exported headers, compiler recipes,
and the actual sparse Mozilla sources. No `libjsrust.a` enters the archive.

`check-build.ts` checks every irregexp compile command, private include paths,
native-Intl exclusion, resolved C++ subset definitions, and the exact new Rust
requirements against the immutable G2 archive. `--verify` replays these checks
without rebuilding or repacking. `native-profile.test.ts` tests rejection paths
and overlay idempotence. These are original checks, not upstream code.

N1 is library proof only. Final side imports and size, both-tier VM behavior,
bootstrap, complete ES RegExp support, and producer admission remain separate.

## Native-profile verification

The compiler gate requires the effective embed define on every target recipe
and rejects conflicting undefines. The archive must retain all four G2 embed
hook requirements. Unicode recipes must match the complete 26-source set at
the pinned revision. Normal and unified source ownership is reconstructed from
the generated backend and unified include files, then checked against both the
archive object list and actual member bytes. These source/object inputs remain
part of replay evidence. A configured recipe is not a compiled-library result.

Receipt creation writes the exported-header manifest. Artifact replay reads and
compares the saved manifest without repairing or replacing it, including on
failure. Missing or changed headers and missing or corrupt manifests fail closed.
The profile tests have a feature-owned blocking quality manifest under scripts.
