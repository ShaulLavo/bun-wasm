# Deferred test collection

Class: Original adapter.

`crates/bunwasm-runtime/src/js/test_collection.ts` owns describe callback
completion and registration admission for the existing runner tree. Its callers
in `bun_test.js` defer callbacks until root imports and top-level await finish,
collect nested scopes before siblings, exclude failed subtrees, and close the
file before execution. The reference is Bun's
`src/runtime/test_runner/Collection.rs` and `ScopeFunctions.rs` at revision
`9510e74152073d850a18758ca41114d8f214ffa6`, with native Bun 1.4.4 at revision
`38afee6c8` supplying the order, return-value and error controls. No upstream
implementation is copied.

A callback's genuine returned Promise is observed with the runtime's existing
intrinsics. Observer callbacks return no user value and resolve collection with
undefined. Completion revokes the callback's registration lease before child
traversal. Collection errors count once as errors, exclude that scope's tests,
hooks and queued descendants, and allow valid siblings. Only-registration remains
sticky, including declarations in a subsequently failed scope. Cached modules
keep their first evaluation's declaration ownership.

Registration is supported when continuations preserve their original private
frame through an existing engine continuation slot or a qualified framed
callback. Exact file/scope identities are required. Missing, closed and
non-admitted frames throw before tree, selection or cleanup-queue mutation.
There is no active-global-scope fallback. Runtime cleanup callbacks without a
collection frame retain the existing live-queue behavior.

Whole-frame context restoration across collection boundaries is unsupported:
public ALS.bind, ALS.snapshot and AsyncResource.runInAsyncScope can restore
another currently admitted frame and pass equality checks. This adapter does
not claim universal detection or native parity for those wrappers.

Browser workers using source hooks are unqualified for arbitrary async
registration. Dynamic/unhooked awaits and the documented rejected-await,
generator and await-using gaps can inherit an incorrect live frame. Node
continuation controls do not qualify those worker paths. A focused passing
subset must be named separately; unsupported observations are not parity passes.
No carrier, provider, public ALS or native ABI changes belong to this adapter.
