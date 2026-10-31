# SpiderMonkey WASI build inputs

The source pin is `mozilla-firefox/firefox@a5df22d986d4b626f771b4f8885241941601c35c`.
This record covers the standalone library build only. It does not describe an
engine adapter, an interrupt implementation, or a runtime correctness result.

| Local path or output | Classification | Upstream source | Local change and reason |
| --- | --- | --- | --- |
| `spidermonkey/fetch-spidermonkey.sh`, generated `firefox/Cargo.toml` | Original adapter using an upstream build transformation | `js/src/make-source-package.py`, `rsync_filter_list`, `is_mozjs_cargo_member`, `is_mozjs_crates_io_local_patch`, and `copy_cargo_toml` at the pin | Reverse the source packager's first-match filters for Git's last-match sparse rules. Include `Cargo.toml` and `CLOBBER`, which the packager handles separately. Invoke its three unmodified manifest helpers to remove browser-only workspace members and local crate patches. No copied helper implementation is checked in. |
| `spidermonkey/common.sh`, `spidermonkey/mozconfig.in`, `spidermonkey/build.sh` | Original adapter | Mozilla's `js/src/devtools/automation/variants/wasi` and `wasi-pbl` at the pin are configuration references | Use the existing consumer sysroot, wasi-sdk 34, PIC, no C++ exceptions, six build jobs, and lane-private build state. Compile PBL without forcing it on. Do not build a shell, JIT, shared memory, or Intl. |
| `spidermonkey/check-build.ts` | Original adapter | Generated `js/src/build/libjs_static_a.list` and support-directory `backend.mk` files at the pin | Pack the generated JS object list and the memory, mozalloc, mfbt, mozglue, and fmt support objects. Keep only C/C++ objects, with no Rust staticlib or sysroot archive. Check object headers, exception tags, PIC compile flags, relocations, and target identity. Hash the exported headers and build inputs. |
| `spidermonkey/spidermonkey-wasi.patch` | Empty patch placeholder | No engine source changes | G1 needs no compiler or sysroot patch. The later interrupt, stack-base, and fatal-hook changes do not belong in this build-only change. |

The support-object selection is re-derived from the pinned build's generated
source recipes. StarlingMonkey's `cmake/spidermonkey.cmake` at
`d7283bba305cffd6831bb65ab8f62500fd509c04` is prior art for packing those objects,
not a copied object list. Mozilla has no final executable link command in this
configuration because `--disable-js-shell` removes the executable target.

Mozilla's WASI variants skip all three test suites. Their completed CI tasks
establish build evidence, not runtime correctness. The PBL interrupt source is
`js/src/vm/PortableBaselineInterpret.cpp`. Its WASI interrupt checks remain
unchanged here and must be addressed and tested in both tiers before integration.
