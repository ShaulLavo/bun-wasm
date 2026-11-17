# SpiderMonkey resizable ArrayBuffer backing

Mozilla is pinned to `mozilla-firefox/firefox@a5df22d986d4b626f771b4f8885241941601c35c`.
These changes are in `spidermonkey/spidermonkey-wasi.patch`. The new slot, the lazy
allocation and the capacity storage compile only for `__wasi__`. Elsewhere the capacity
is the maximum, so `growCapacity()` never grows anything. The split and shared-group
libraries both apply that patch.

| Upstream paths | Class | Local change and reason |
| --- | --- | --- |
| `js/src/vm/ArrayBufferObject.h`, `js/src/vm/ArrayBufferObject.cpp` | Port | Upstream `ResizableArrayBufferObject::createBufferAndData` allocates the whole maximum up front, because its native ports expect a virtual reservation. WASI linear memory has none, so a few buffers with large maxima filled the 1 GiB guest. A buffer whose maximum is too large to be inline now allocates only its initial length (at least one byte, so its data pointer is never null) and records that capacity in a new `CAPACITY_SLOT`. `resize()` and a resizability-preserving `transfer()` grow it by reallocation to the larger of the request and 1.5 times the capacity, never past the maximum, computing in 64 bits before narrowing. Shrinking keeps the capacity and clears the truncated bytes, so bytes from the length to the capacity are always zero, and growth clears only the newly allocated tail. Inline buffers, whose maximum fits in the object, keep the maximum as their capacity. |
| same | Port | A growth that cannot be allocated throws the RangeError that `CreateByteDataBlock` specifies, as `failed to grow ArrayBuffer` (reusing `JSMSG_WASM_BAD_GROW`), and leaves the buffer, its length, its contents and its views unchanged. It tries the geometric size, then the exact size, then the runtime's out-of-memory path with the buffer rooted. A transfer grows the source before anything is detached, so a failed transfer leaves the source attached. |
| same | Port | Malloc accounting, `stealMallocedContents` and the finalizer use the capacity instead of the maximum, so each allocation is charged and freed with the size it has. |

Unlike upstream's fixed backing, this backing can move when a resize grows it. The
buffer publishes the new data pointer, then updates every view, including views that
are out of bounds at that moment, before anything else can run. Native code must not
hold a resizable buffer's data pointer across user JavaScript (coercion, getters,
callbacks) or async work: take the pointer after the last point where user code can
run, copy the input first, or pin the length. `resize()` and `transfer()` refuse a
buffer whose length is pinned (`JS::PinArrayBufferOrViewLength`) with
`JSMSG_ARRAYBUFFER_LENGTH_PINNED`, so its pointer stays valid until it is unpinned.

Growable `SharedArrayBuffer` keeps upstream behavior, because other threads may hold
its data pointer and it can never move: `SharedArrayRawBuffer::Allocate` allocates the
maximum up front and `grow()` only publishes a new length. On the split guest, three
growable buffers with a 256 MiB maximum fit and the fourth throws `out of memory`. The
shared-group library refuses a growable `SharedArrayBuffer` with RangeError
([shared-group record](spidermonkey-shared-group.md)).

`tests/fixtures/resizable-backing` now runs its eight 256 MiB maxima on every engine,
including SpiderMonkey. `tests/fixtures/resizable-growth` checks stepwise growth with
allocations in between, shrink and regrowth, typed array and DataView views (fixed,
length-tracking and out of bounds) that follow a moved backing, and growing and
shrinking transfers on all four engines. `tests/fixtures/resizable-allocation-failure`
checks that a resize or transfer the guest cannot back throws RangeError and keeps the
buffer on JSC and SpiderMonkey. QuickJS throws `InternalError: out of memory` there
instead, and Browser runs on the host's memory.
