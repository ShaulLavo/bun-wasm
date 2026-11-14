# Scalar data encoding

`crates/bunwasm-runtime/src/data/codec.rs` is an original bun-wasm adapter.
It implements the owned-data wire format for core operations and linked engine
programs. No upstream source or revision applies to this change.

The encoder writes the root value directly. For arrays and objects, it writes
scalar prefixes directly and queues the remaining values at the first nested
container. Nested traversal remains iterative. This removes temporary traversal
allocations for scalar results and flat argument lists while preserving field
order, byte encoding, checked allocations, and structural nesting support.

The existing codec and operation tests cover every tag, malformed inputs,
transport ownership, and nested calls. Codec regressions additionally check exact
bytes when scalar prefixes surround nested containers and encoding through
10,000 levels of containers with scalar prefixes.

| Source | Class | Local change |
| --- | --- | --- |
| `crates/bunwasm-runtime/src/data/codec.rs` | Host feature | Encode scalar roots and container prefixes without queuing them. |
