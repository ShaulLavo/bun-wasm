# JSC WASI resizable backing design

Status: awaiting parent independent design review before backing implementation.

Source main: `6b815599e7585ca9da3b12997842e8a313185637`. Pinned WebKit: `3d3257150c40a1aabdc5f8b48d5b33d0413674cb`.

## Contract and existing supported mechanisms

WASI has no usable virtual reservation/protection or decommit for this malloc-based C-loop build. The earlier design that mallocs the maximum is rejected: it would commit every maximum eagerly. The upstream fork already supports relocating nonshared Wasm backing through `ArrayBuffer::refreshAfterWasmMemoryGrow`, incoming JS view references, and `JSArrayBufferView::refreshVector`. The resizable iteration path reloads typedVector after callbacks; sort reloads its destination after callbacks. C API raw pointers are explicitly temporary across JSC API calls in API/JSTypedArray.h:96,162. They do not promise stable storage across reentry.

Use the existing relocation machinery for WASI nonshared RABs. Keep fixed buffers, Wasm memory, SAB and GSAB allocation separate. GSAB retains its existing unavailable result; no cross-agent relocation is introduced.

## Types, ownership and exact source hunks

- `jsc/webkit-wasi.patch`, existing `ArrayBuffer.cpp::tryAllocateResizableMemory` WASI arm. Add an explicit sharing argument, default nonshared, and pass Shared from tryCreateShared. Shared remains unavailable. Check page rounding before conversion, allocate only max(one page, rounded initial length) through fallible Gigacage malloc, charge only that allocation through existing BufferMemoryManager physical accounting. Return a typed WASI malloc BufferMemoryHandle. Logical maximum remains checked metadata, not a claimed virtual reservation.
- New patch hunk `BufferMemoryHandle.h/.cpp`. Add a WASI-only allocation kind and creation/reallocation helpers. Ordinary virtual-page handles remain unchanged. WASI malloc handles own exactly one malloc allocation, with size and mappedCapacity describing actual allocated capacity, maximum describing the accepted logical page bound. On growth, charge the delta then use fallible matching realloc. Failure rolls the charge back and leaves pointer, length and existing bytes intact. No JS runs between successful realloc and publication. Destructor frees physical accounting once and uses matching Gigacage::free, never virtual-page free or protection. RefCounted lifetime and ArrayBufferContents move/swap/detach already move the handle.
- New `ArrayBuffer.cpp::resize` WASI malloc branch and small refresh helper shared with refreshAfterWasmMemoryGrow. Enforce logical max first. Retain capacity on shrink, clear truncated bytes, update only logical length, and refresh every incoming JS typed-array/DataView vector if growth moved the base. Growth clears every newly exposed byte, including previous shrink tails. Retaining high-water capacity avoids fallible shrinking and pointer churn. No eager maximum allocation. Report true capacity growth to heap allocation accounting, not repeated logical regrowth inside retained capacity.
- New `ArrayBuffer.h::gcSizeEstimateInBytes` WASI malloc case. Count retained capacity, rather than current shrunken logical length, so GC does not undercount live backing.
- New `ArrayBufferView.h::baseAddress` WASI nonshared RAB case. Native wrappers reload buffer data plus their raw offset, rather than a stale cached base, matching the existing dynamic length checks. No returned pointer may cross a JSC API call.

Transfer/detach use unchanged contents move/swap and notifyDetaching. Detached JS views clear vector/length/offset. The allocation belongs to the transferred handle, or is destroyed once after explicit detach. Shared contents never receive this kind. Ordinary split profile and all memory maxima stay unchanged.

## Review questions and proof

The key review question is whether any C-loop native RAB algorithm caches a vector across a user callback without reloading it. Audit all such call sites before implementation. The existing Wasm relocation and resizable iteration paths provide precedent, but are not a blanket proof.

Controls will cover tiny initial/large logical maximum, zero initial/nonzero maximum, same-page and cross-page growth/shrink, zeroing, fixed/tracking Uint8Array and DataView bounds, callbacks that relocate during iteration/coercion/sort, native wrappers, fixed-buffer detach and RAB transfer, repeated allocate/resize/detach/GC and maximum rejection. Run focused controls three times, unchanged upstream buffer and concat names, plus all-engine existing construction/concat/decoder neighbors. Native Bun is the primary oracle for differences. No upstream tests or expected output are changed.
