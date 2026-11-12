### Source-map position lookup

`crates/bunwasm-runtime/src/sourcemap.rs` is an **Original adapter** for source-map v3 mappings used by stack and call-site queries. It is local code, not copied or adapted from Bun, Node or WebKit. There is no upstream source path or revision for this implementation.

The bounded lookup work retains the encoded map and relative source, line and column state. Its focused native controls exercise the exact Rust module and the production `PositionMap::original_position` method without building an engine. These controls are original test adapters as well.
