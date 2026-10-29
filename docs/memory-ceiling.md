# Why Bun's Wasm memory stays at 512 MiB

Bun core and its QuickJS or JavaScriptCore engine share one wasm32 linear memory.
The configured maximum is still 512 MiB, or 536870912 bytes.

Previously, Bun's `EncodedSlice` stored three flags in address bits 29, 30, and 31
on wasm32. UTF-8, global allocation, and UTF-16 flags left only 29 address bits.
An address at or above 512 MiB could become a flag and decode to the wrong address.
The memory cap prevented that corruption.

Patch [0019](bun-patches/0019-wasm32-string-flags.md) implements design A.
On 32-bit targets, `EncodedSlice` stores the full pointer and a separate flags byte.
It grows from 8 to 12 bytes, and its containing `bun_core::String` grows from
12 to 16 bytes. Native64 keeps its existing layout and pointer flags.
All Rust users compile against the same definition. The wasm32 hosts exchange
addresses and bytes, not either string structure. Native C++ peers keep their
existing layout.

This removes the string representation's 512 MiB limit. It does not raise the
configured cap, establish Next.js acceptance, or prove a workload's resident memory.
Stock Rolldown's 1 GiB loader requirement is a separate capacity requirement;
it is not evidence of a 1 GiB resident working set. Waste and retention fixes
remain necessary regardless of capacity.

## Capacity increases in separate units

- **512 MiB, stage 0:** the new representation. Standalone actual-source tests
  check layouts, constructors, substrings, truncation, lifetime detachment, and
  synthetic addresses through `0xffffffff` without dereferencing them.
- **1 GiB, stage 1:** integrate one authoritative maximum with the shared-group
  build profile after its contract lands. Linker limits and JSC's `forceRAMSize`
  must agree. No second authority is introduced here. Force real string
  allocations above 512 MiB, compare build output, and run each engine's workflow
  and retention gates. Measure workload string counts and transpile costs with
  the coordinated guest producer; stage 0 measures only the actual type sizes.
- **2 GiB, stage 2:** repeat near the signed-address boundary with real
  allocations and each engine's safety and workflow checks.
- **Above 2 GiB, stage 3:** first normalize exported and imported i32 pointers to
  unsigned addresses in Waffle and bun-wasm's browser host. Waffle's fix must land
  before updating its dependency pin. Then check high-address I/O and host results
  and repeat the engine gates, up to wasm32's 4 GiB address space.

At every increase, a configured maximum is distinct from memory a device can
supply. Record successful growth and allocation failures on desktop browsers and
iOS Safari. A synthetic pointer test does not establish device availability.
Rust's single-allocation limit and each engine's string and ArrayBuffer limits
also remain. Raising JSC's RAM estimate can change when it collects garbage.

## The wasm64 alternative

Memory64 uses 64-bit addresses and could avoid wasm32's 4 GiB address space limit.
It is a separate port, not a linker setting for this change. It requires checking
Rust, the WASI SDK and sysroot, QuickJS, JSC, the Wasm interpreter, and Waffle's
host interfaces, including BigInt addresses. Browser support, especially Safari
on macOS and iOS, toolchain readiness, and memory-heavy performance have not been
established by this stage-0 work. No wasm64 support or speed claim is made here.

The bounded wasm64 research and staged workload checks remain separate work.
For other constraints, see [Limits](limits.md).
