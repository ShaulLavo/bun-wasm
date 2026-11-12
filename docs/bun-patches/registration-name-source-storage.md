## Registration name source storage

Class **Host feature**. `crates/bunwasm-transpiler/src/register.rs` is an original
bun-wasm registration adapter, not copied Bun code. Its naming pass calls Bun's
AST API at the revision pinned in `scripts/sync-bun.sh`, currently
`9510e74152073d850a18758ca41114d8f214ffa6`. No upstream source changes.

The naming pass borrows the source for its lexical lifetime instead of cloning
it beside the live AST. Its decoded view also borrows when neither `\u` nor
`\x` occurs. Sources that can contain those supported escapes retain the same
owned decoder and collision checks. The source and decoded view cannot escape
registration preparation; generated names remain owned in the returned record.

This removes one source-sized allocation unconditionally, and a second when no
supported escape prefix occurs. It does not change parsing, module requests,
record output, memory limits, or allocator behavior. The inline
`source_memory_tests` check borrowing and preserved escape/name collisions. The
existing generated-name and fixture-record tests continue to cover the adapter's
output.
