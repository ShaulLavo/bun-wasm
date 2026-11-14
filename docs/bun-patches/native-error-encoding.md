# Native error reply encoding

Class **Host feature**. The split data codec and reply transport are original
adapters. No upstream implementation is copied or adapted.

`crates/bunwasm-runtime/src/ops.rs` retains each failed native's owned
`NativeError` until `ops/abi.rs` encodes it. `data/codec.rs` borrows its strings
and property values to write the existing split error record directly, without
building a temporary `Val` record. The record keeps `kind`, `message`, `name`
and `props` in order. Properties remain ordered two-element arrays, including
duplicates. Every nested value uses the ordinary codec's tags and exact bits.

The success writer, status words, decoder and legacy Browser codec are
unchanged. Both encoding passes use iterative traversal. After encoding,
including recoverable encoding failure, the transport drains owned property
values iteratively before propagating the result. This does not add recovery
from arbitrary process-wide allocator failure.

The differential tests retain the old record builder as a byte oracle. They
cover all error kinds and value tags, names, duplicate properties, Unicode,
noncanonical NaN bits, and destination length mismatches. Physical transport
tests exercise deep metadata through successful encoding and exhausted reply
allocation, alongside existing ownership and malformed-input tests.
