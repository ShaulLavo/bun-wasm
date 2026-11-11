# JSC array literal allocation

File `Source/JavaScriptCore/bytecompiler/NodesCodegen.cpp` in `jsc/webkit-wasi.patch`, Bun's
WebKit fork at `3d3257150c40a1aabdc5f8b48d5b33d0413674cb`. Class **Port**.

JSC keeps an array literal whose elements are all constants as one copy-on-write buffer. The
buffer is a garbage collected cell, and `ArrayNode::emitBytecode` allocates it while it generates
the enclosing function's bytecode. Upstream asks for it with `JSCellButterfly::tryCreate` and then
asserts the result (`RELEASE_ASSERT(array)`, line 498 at the pin). A failed allocation therefore
ends the process inside the compiler, before any JavaScript of that function runs and with no
error a program could catch. Collection is deferred for the whole of bytecode generation, so the
heap cannot make room at that point either.

On native platforms the allocation practically never fails. A Wasm guest is different: its
allocator returns null as soon as the host refuses to grow linear memory, while the guest still
has free memory for smaller requests. A small literal needs a fresh 16 KiB heap block when its
size class has no free cell. A literal of more than about 1,000 elements needs one allocation of
its whole size.

Under `OS(WASI)` a failed buffer allocation now falls through to `emitNewArray`, the path every
literal with a non-constant element already takes. The function gets ordinary bytecode that
builds the array from its elements on each evaluation, with the indexing type the constant path
would have recommended, less the copy-on-write bit. Behavior is unchanged: the literal still
yields a fresh array per evaluation. If the array's own storage cannot be allocated when the code
runs, the existing run-time path throws a catchable `RangeError: Out of memory`. Other platforms
keep upstream's assertion, and nothing changes when the buffer is allocated.

This makes one refusal survivable. It does not add memory, and a guest whose host keeps refusing
growth still fails at its next allocation that cannot return null.

## Regression

`tests/jsc-embedding/array-literal-allocation` runs in the JSC gate (`scripts/jsc-embedding.ts`)
on the matched pair. The Node host's `--refuse-engine-allocation MINIMUM-MAXIMUM:COUNT` option
(`web/scripts/node-linked.ts`) wraps the libc allocation functions the engine side imports from
its core and returns their failure result for the first `COUNT` requests in the byte range. The
fixture compiles a function whose top level declares one 10,000-element constant array. The
gate refuses two requests of 80,000 to 80,511 bytes: the literal's buffer during bytecode
generation, then the array's storage on the first call. The first call must throw the catchable
`RangeError`, the second must build the array, and each evaluation must give a fresh array.
Without the hunk the first refusal traps in `WTFCrashWithInfo` under `ArrayNode::emitBytecode`.

The refusal is injected at the allocator boundary. It models a host that cannot grow memory and
says nothing about why a particular browser refuses.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`jsc/webkit-wasi.patch`, array literal allocation](#jsc-array-literal-allocation) | Port | Build a constant array literal from its elements when its shared buffer cannot be allocated, instead of asserting. |
| `web/scripts/node-linked.ts`, `web/scripts/node-host.ts` | Original test adapter | Node host option that refuses selected engine-side allocations at the core boundary. No upstream code copied. |
| `tests/jsc-embedding/array-literal-allocation` | Original adapter | Exercise a refused buffer through the guest entry point. |

[Ledger scope and pinned revisions](scope.md).
