### Source-map position lookup

`crates/bunwasm-runtime/src/sourcemap.rs` is an **Original adapter** for source-map v3 mappings used by stack and call-site queries. It is local code, not copied or adapted from Bun, Node or WebKit. There is no upstream source path or revision for this implementation.

Lookup retains the encoded map and relative source, line and column state in a constant-size line cursor. A fixed four-field decoder replaces temporary VLQ vectors. Streaming selection preserves the former stable sort's last equal-column match and first minimum-column fallback. Only the requested prefix is decoded. Reached malformed segments retain the former decoder's behavior, while unvisited suffixes and line-zero queries are not decoded. Identical queries reuse one cached result. Backward queries restart at the map's beginning, and a different column scans the requested line again.

The former allocating decoder survives only as a test oracle. The focused native controls exercise the exact Rust module and production `PositionMap::original_position` method without building an engine. They check debug and release semantics, multisource deltas, allocation counts and query costs. These controls are original test adapters as well.
