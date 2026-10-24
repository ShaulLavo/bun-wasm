### WebKit platform hunks

File `jsc/webkit-wasi.patch`. The following hunks have class **Port**.

| WebKit file | Change | What breaks without it |
| --- | --- | --- |
| `Source/JavaScriptCore/CMakeLists.txt` | Link the two LLInt extractors with imported memory. | wasm-ld trims trailing zero data that offlineasm expects to scan. |
| `Source/JavaScriptCore/heap/RegisterState.h` | Avoid `setjmp` and provide an inert WASI register-state structure. | WASI has no supported native register-spill API. Wasm locals need the separate spill-pointers finalization. |
| `Source/JavaScriptCore/runtime/JSCBytecodeCacheVersion.cpp` | Exclude `dlfcn.h` for WASI. | The dynamic-loader header is unavailable. |
| `Source/JavaScriptCore/runtime/Options.cpp` | Add the WASI `size_t` parser specialization. | WASI's distinct integer types leave the option parser without an implementation. |
| `Source/WTF/wtf/PlatformHave.h` | Disable the resource-header capability on WASI. | Native resource API assumptions fail. |
| `Source/WTF/wtf/PlatformOS.h` | Define `OS(WASI)` and include it in Unix-like selection. | WASI gets no usable platform selection. |
| `Source/WTF/wtf/PlatformRegisters.h` | Avoid the native ucontext header. | The header is unavailable. |
| `Source/WTF/wtf/RandomDevice.cpp` | Use `getentropy` in chunks of at most 256 bytes. | WASI has no `/dev/urandom` path. |
| `Source/WTF/wtf/RawHex.h` | Include WASI's distinct 32-bit integer overloads. | The integer overload set is incomplete for the WASI ABI. |
| `Source/WTF/wtf/StackBounds.cpp` | Read wasm-ld's shadow-stack bound symbols. | Native pthread stack discovery cannot find the wasm shadow stack. |
| `Source/WTF/wtf/dtoa/utils.h` | Recognize wasm's correct double operations. | double-conversion rejects the unrecognized architecture at compile time. |
| `Source/bmalloc/libpas/src/libpas/pas_lock.h` | Accept WASI in the lock platform selection. | The header rejects this target even though bmalloc is disabled. |
| `Source/cmake/OptionsJSCOnly.cmake` | Disable native API tests for WASI. | The cross-build includes unsupported test targets. |
| `Source/cmake/WebKitCommon.cmake` | Recognize CMake's WASI system name. | Configure rejects the OS. |

`jsc/wasi-jsc.cmake`, `jsc/configure.sh`, and `jsc/shim/wasi-compat.{h,c}` plus `madvise.c` are our **Port** configuration and glue, not edits to upstream source. They select the C-loop interpreter, system malloc, single-thread GC, and disabled JIT/Wasm tiers; supply temporary-file helpers and inert signal/scheduling declarations; and link the WASI support library. Without them the target cannot configure or link. `jsc/finalize.sh` runs Binaryen's `--spill-pointers`, without which conservative GC misses references in wasm locals. See [the JSC notes](../jsc-build.md).


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`jsc/webkit-wasi.patch`, platform hunks](#webkit-platform-hunks) | Port | Compile the C-loop interpreter and WTF for WASI. |

[Parent context](bun-patch-series.md).
