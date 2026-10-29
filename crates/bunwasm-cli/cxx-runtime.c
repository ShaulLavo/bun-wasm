// The shared-group core's whole C++ runtime need: BoringSSL references only these two
// functions. Both are documented C++ override points (the replaceable sized `operator delete`,
// and libc++'s `_LIBCPP_OVERRIDABLE_FUNC_VIS` `std::__libcpp_verbose_abort`), with the same
// bodies as libc++abi/libc++ at LLVM 895aa2c896ad (wasi-sdk 34). Defining them here keeps
// every SDK libc++/libc++abi member out of the link: the stock noeh members they would pull
// (`cxa_handlers`, `cxa_default_handlers`) disallow shared memory, and the `-threads` archives
// are not PIC. wasm-ld keeps its full feature check; the link map proves zero members.
#include <stdarg.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>

void bun_cxx_sized_delete(void *pointer, size_t size) __asm__("_ZdlPvm");
_Noreturn void bun_cxx_verbose_abort(const char *format, ...)
    __asm__("_ZNSt3__222__libcpp_verbose_abortEPKcz");

void bun_cxx_sized_delete(void *pointer, size_t size) {
    (void)size;
    free(pointer);
}

_Noreturn void bun_cxx_verbose_abort(const char *format, ...) {
    va_list list;
    va_start(list, format);
    vfprintf(stderr, format, list);
    va_end(list);
    abort();
}
