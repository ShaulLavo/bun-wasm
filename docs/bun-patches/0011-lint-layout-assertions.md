## 0011 lint layout assertions

Class **Port**. Upstream `src/lint/rule.rs` at Bun revision
`a7733435cf40429e3b35c36072769df2052b80f1` asserts that `Message` is five
pointer-sized words. Its two strings occupy four pointer-sized words, followed
by eight bytes for the flag, key, and padding. That is 40 bytes on 64-bit
targets and 24 on wasm32, rather than five words on every target. The patch
states the size as `4 * size_of::<usize>() + 8`. It changes no representation
or lint behavior. The original assertion failed during the wasm32 linter check;
all native rule crates, formatter, and driver pass `cargo check` with it.

Until Bun 1.4.5 the patch also made the `TypeArguments` size assertion in
`src/sema/types.rs` pointer-width aware, because that enum was two pointer-sized
words. Since 1.4.5 it holds up to three type ids inline and is 16 bytes on
64-bit and wasm32 alike, so upstream's `== 16` passes unchanged and that hunk
is gone.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [0011](#0011-lint-layout-assertions) | Port | Make the lint-message size assertion pointer-width aware. |

[Ledger scope and pinned revisions](scope.md).
