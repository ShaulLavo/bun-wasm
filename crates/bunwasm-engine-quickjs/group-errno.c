// errno for the Rust std inside a shared-group QuickJS side (scripts/build-engine-quickjs.sh).
//
// Rust std on WASI reads wasi-libc's `errno` as a thread-local. A shared-group side is built
// with wasm atomics, so that read is a real TLS access, and WebAssembly TLS cannot reach a
// symbol of another module: the side needs its own `errno`. libc stays in the core, so each
// core function std calls and then inspects errno for is wrapped (`--wrap`) to copy the
// calling member's core errno into this one when it fails. The producer refuses a side whose
// std imports another errno-setting core function.
#include <errno.h>
#include <sys/uio.h>
#include <time.h>
#include <unistd.h>

_Thread_local int errno;

// The core's accessor for its own (thread-local) errno: crates/bunwasm-glue/src/extra.rs.
int *errno_location(void);

static void take_core_errno(void) { errno = *errno_location(); }

ssize_t __real_write(int fd, const void *buffer, size_t length);
ssize_t __real_writev(int fd, const struct iovec *vectors, int count);
int __real_clock_gettime(clockid_t clock, struct timespec *time);
char *__real_getcwd(char *buffer, size_t size);

ssize_t __wrap_write(int fd, const void *buffer, size_t length) {
    ssize_t result = __real_write(fd, buffer, length);
    if (result < 0) take_core_errno();
    return result;
}

ssize_t __wrap_writev(int fd, const struct iovec *vectors, int count) {
    ssize_t result = __real_writev(fd, vectors, count);
    if (result < 0) take_core_errno();
    return result;
}

int __wrap_clock_gettime(clockid_t clock, struct timespec *time) {
    int result = __real_clock_gettime(clock, time);
    if (result != 0) take_core_errno();
    return result;
}

char *__wrap_getcwd(char *buffer, size_t size) {
    char *result = __real_getcwd(buffer, size);
    if (!result) take_core_errno();
    return result;
}
