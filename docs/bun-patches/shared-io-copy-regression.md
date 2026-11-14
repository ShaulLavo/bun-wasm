# Shared I/O copy regression

Class **Host feature**. The original Rust tests in
`crates/bunwasm-runtime/src/natives/io_copy_tests.rs` exercise the existing read
native through the real plain-data dispatcher and physical transport. No
upstream implementation is copied or changed.

A 40 MiB file and caller-owned destination precede allocation measurement.
Positional, cursor and offset reads use requests of at most 1 MiB. The existing
Rust test allocator measures both the largest allocation and peak live bytes
through native reads, request/reply encoding and reply decoding. Both must stay
below 8 MiB. A second arm inserts a discarded whole-file copy before the first
native read, keeps the same requests and data checks, and must fail the same
limit. Bounded wire requests alone would accept that control.

These tests do not execute the shared JavaScript read loop, its borrowed
destination conversion, engine `ValueFn` conversion or engine C++ allocation.
They establish a Rust native/transport regression check, not a universal
allocation check for the complete read call. The historical Wasm-capacity
fixture assertion remains until a direct replacement covers the intended
shared read/copy contract. The existing Rust test owner discovers these tests;
the ordinary three-engine large-I/O fixture remains with its existing owner.
