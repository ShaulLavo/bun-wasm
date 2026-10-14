/* wasi-emulated-mman has mmap/munmap/mprotect but no madvise; advice is optional by contract.
 * Its own object file, so a link that already has a madvise (bunwasm-posix) never pulls this one. */
#include <stddef.h>

int madvise(void* addr, size_t len, int advice)
{
    (void)addr;
    (void)len;
    (void)advice;
    return 0;
}
