## 0011 lint layout assertions

Class **Port**. Upstream `src/sema/types.rs` at Bun revision
`9510e74152073d850a18758ca41114d8f214ffa6` asserts that `TypeArguments` is
16 bytes. The enum occupies two pointer-sized words, so it is 8 bytes on
wasm32. The patch retains the size guard as `2 * size_of::<usize>()`.
It changes no representation or type-checking behavior. Compiling the unchanged
semantic checker for wasm32 reproduced the original constant-evaluation failure;
its dependent linter crates compile after the assertion is made portable.


The same patch updates the size assertion for `src/lint/rule.rs::Message`.
Its two strings occupy four pointer-sized words, followed by eight bytes for the
flag, key, and padding. That is 40 bytes on 64-bit targets and 24 on wasm32,
rather than five words on every target. The original assertion failed during
the wasm32 linter check; all native rule crates, formatter, and driver pass
`cargo check` after both size guards are made portable.



## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [0011](#0011-lint-layout-assertions) | Port | Make semantic type-argument and lint-message size assertions pointer-width aware. |
