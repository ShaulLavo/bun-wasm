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

The companion `io_embedding_tests.rs` loads the actual `web.js`, `buffer.js`
and `node_fs.js` factories into the production QuickJS Rust embedding. The
existing plain-data-to-`ValueFn` adapter moved unchanged into the shared private
`engine::data_fn` helper, so the embedding and engine programs use the same
argument and result conversion. Native reads run through the real runtime
registry, dispatcher and physical transport. The fixture owns timer delivery.

After file, data and destination setup, the test sets QuickJS's existing
`JS_SetMemoryLimit` to measured heap bytes plus 8 MiB and arms the Rust allocator
witness. Ordinary JavaScript ArrayBuffer backing is charged to that QuickJS
limit. Native result backing transferred from a Rust Vec is covered by the
Rust witness. The deliberate `new Uint8Array(target)` control runs before the
first bounded native read under the same allowance and must report the exact
ArrayBuffer backing refusal. No collection is forced, and no production memory
limit, GC policy, engine source or upstream patch changes.

This bounds the shared JavaScript, borrowed conversion, `ValueFn` and native
read path in this QuickJS embedding. Engine-specific allocation and collector
overhead on other engines remain separate. The existing Rust test owner
discovers the direct checks. The ordinary three-engine large-I/O fixture keeps
its existing owner and all read and codec correctness assertions.
