# Shared core libc++ sort specialization

Classification: Port, adapted upstream source. LLVM revision
`895aa2c896ada719451be2e3673c83da8ddf1141`, `libcxx/src/algorithm.cpp`,
supplied by wasi-sdk 34.0. `crates/bunwasm-cli/cxx-sort.cpp` retains its license,
`__sort` definition and only the unsigned-short explicit instantiation.
All other instantiations are omitted because the current BoringSSL TLS extensions
object imports only this specialization. The implementation remains LLVM's real
introsort, not a replacement sorting routine or a link stub.

The first ordinary transpiler-enabled shared core exposed this additional actual
C++ dependency after removing the non-atomic SDK archives. Compile this one source
with the matching SDK headers, PIC, atomics, bulk memory and mutable globals.
Normal target-feature checking and link-map inspection stay enabled. Split cores
still use their normal SDK runtime archives. A new unresolved C++ dependency fails
the link rather than admitting a non-atomic archive silently.
