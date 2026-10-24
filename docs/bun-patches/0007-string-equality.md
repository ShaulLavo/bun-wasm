### 0007 string equality

File `0007-wasm-strings-eql-compares-8-byte-words-on-32-bit-tar.patch`. Class **Upstream bug**.

`src/bun_core/string/immutable.rs::eql_long` counts eight-byte words but originally loads and advances by `usize`. It also skips its four-byte tail on 32-bit targets. Read eight-byte words consistently and always check the four-byte tail. Without it different strings can compare equal, causing incorrect identifier matching and minified loop labels.

This classification is a judgment about the algorithm, not a claim that native Bun 1.4.2 ships a broken 32-bit binary. The same Rust function is incorrect on any 32-bit platform. Extracting the exact unpatched function from the pinned source gives `eql(b"abcd", b"wxyz", true) == true` on wasm32 and `false` on native x86_64. The patched function returns `false` on wasm32. The installed native Bun 1.4.2 is 64-bit and does not reach the faulty width case.

No upstream issue has been posted.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [0007](#0007-string-equality) | Upstream bug | Correct string comparisons that skip bytes with 32-bit `usize`. |

[Parent context](bun-patch-series.md).
