### ICU

`jsc/build-icu.sh` builds ICU **78.3**. Class **Port** for each of the following changes.

The script copies `source/config/mh-linux` to `mh-unknown` in the wasm source tree and clears `GENCCODE_ASSEMBLY` there. Without this build-time rewrite ICU has no usable WASI platform makefile and attempts unsupported native assembly output. There are no other local ICU source edits.

The script also filters the embedded data to root and English locales and removes converters, transliterators, and Unicode names. This is a data modification, not a C++ source patch. Without filtering the binary carries substantially more locale data against the 512 MiB wasm limit. Other locales fall back to root. Flags disable mmap, dynamic loading, and native timezone globals. These are port configuration decisions.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`jsc/build-icu.sh`, makefile rewrite](#icu) | Port | Select a usable cross-build makefile without native assembly output. |
| [`jsc/build-icu.sh`, filtered ICU data](#icu) | Port | Reduce the embedded locale data to fit the wasm memory budget. |

[Parent context](bun-patch-series.md).

[Ledger scope and pinned revisions](scope.md).
