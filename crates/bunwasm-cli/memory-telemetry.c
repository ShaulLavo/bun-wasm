#include <stdint.h>
#include <errno.h>
#include <stdlib.h>
#include <malloc.h>

#if defined(__wasm__)
#define EXPORT(name) __attribute__((export_name(name)))
#else
#define EXPORT(name)
#endif

#define UNKNOWN UINT64_MAX

enum Category { NONE, MALLOC, CALLOC, REALLOC, ALIGNED_ALLOC, POSIX_MEMALIGN };
struct MemoryTelemetry {
    uint64_t version, byte_length, live, peak, failed_size, failed_category;
    uint64_t failures, allocations, frees, capacity;
};
_Static_assert(sizeof(struct MemoryTelemetry) == 80, "memory telemetry ABI");
static struct MemoryTelemetry counters = { 1, 80, 0, 0, UNKNOWN, NONE, 0, 0, 0, UNKNOWN };
struct MemoryFailureTelemetry {
    uint64_t version, byte_length, failed_size, failed_category, previous_usable;
    uint64_t live, peak, capacity_before, capacity_after;
    uint64_t growth_successes, growth_failures, growth_last_increment, growth_first_failed_increment;
};
_Static_assert(sizeof(struct MemoryFailureTelemetry) == 104, "memory failure telemetry ABI");
static struct MemoryFailureTelemetry failure = {
    2, 104, UNKNOWN, NONE, UNKNOWN, UNKNOWN, UNKNOWN, UNKNOWN, UNKNOWN, UNKNOWN, UNKNOWN, UNKNOWN, UNKNOWN
};
static struct GrowthTelemetry {
    uint64_t successes, failures, last_increment, first_failed_increment;
} growth;
static unsigned depth;

void *__real_malloc(size_t);
void *__real_calloc(size_t, size_t);
void *__real_realloc(void *, size_t);
void __real_free(void *);
void *__real_aligned_alloc(size_t, size_t);
int __real_posix_memalign(void **, size_t, size_t);
void *__real_sbrk(intptr_t);

static void enter(void) {
    if (depth++ != 0) return;
    growth = (struct GrowthTelemetry) { 0, 0, UNKNOWN, UNKNOWN };
}

void *__wrap_sbrk(intptr_t increment) {
    void *result = __real_sbrk(increment);
    if (!depth || increment <= 0) return result;
    growth.last_increment = (uint64_t) increment;
    if (result != (void *) -1) {
        growth.successes++;
        return result;
    }
    if (!growth.failures++) growth.first_failed_increment = (uint64_t) increment;
    return result;
}

static uint64_t usable(void *pointer) {
    return pointer ? malloc_usable_size(pointer) : 0;
}

static uint64_t capacity(void) {
#if defined(__wasm__)
    return (uint64_t) __builtin_wasm_memory_size(0) * 65536;
#else
    return UNKNOWN;
#endif
}

static void allocated(void *pointer, uint64_t previous, uint64_t requested, enum Category category,
                      uint64_t capacity_before) {
    if (!pointer) {
        if (!requested) return;
        counters.failures++;
        if (counters.failed_category != NONE) return;
        counters.failed_size = requested;
        counters.failed_category = category;
        failure = (struct MemoryFailureTelemetry) {
            2, 104, requested, category, previous, counters.live, counters.peak, capacity_before, capacity(),
            growth.successes, growth.failures, growth.last_increment, growth.first_failed_increment
        };
        return;
    }
    counters.live = counters.live - previous + usable(pointer);
    if (counters.live > counters.peak) counters.peak = counters.live;
    counters.allocations++;
}

EXPORT("malloc") void *__wrap_malloc(size_t size) {
    enter();
    void *pointer = __real_malloc(size);
    if (--depth == 0) allocated(pointer, 0, size, MALLOC, UNKNOWN);
    return pointer;
}

EXPORT("calloc") void *__wrap_calloc(size_t count, size_t size) {
    uint64_t requested = size && count > SIZE_MAX / size ? UNKNOWN : (uint64_t) count * size;
    enter();
    void *pointer = __real_calloc(count, size);
    if (--depth == 0) allocated(pointer, 0, requested, CALLOC, UNKNOWN);
    return pointer;
}

EXPORT("realloc") void *__wrap_realloc(void *previous, size_t size) {
    uint64_t before = depth == 0 ? usable(previous) : 0;
    uint64_t capacity_before = depth == 0 ? capacity() : UNKNOWN;
    enter();
    void *pointer = __real_realloc(previous, size);
    if (--depth != 0) return pointer;
    if (!pointer && !size && previous) {
        counters.live -= before;
        counters.frees++;
        return pointer;
    }
    allocated(pointer, before, size, REALLOC, capacity_before);
    return pointer;
}

EXPORT("free") void __wrap_free(void *pointer) {
    uint64_t before = depth == 0 ? usable(pointer) : 0;
    enter();
    __real_free(pointer);
    if (--depth != 0 || !pointer) return;
    counters.live -= before;
    counters.frees++;
}

EXPORT("aligned_alloc") void *__wrap_aligned_alloc(size_t align, size_t size) {
    enter();
    void *pointer = __real_aligned_alloc(align, size);
    if (--depth == 0) allocated(pointer, 0, size, ALIGNED_ALLOC, UNKNOWN);
    return pointer;
}

EXPORT("posix_memalign") int __wrap_posix_memalign(void **out, size_t align, size_t size) {
    enter();
    int result = __real_posix_memalign(out, align, size);
    if (--depth == 0 && result == 0) allocated(*out, 0, size, POSIX_MEMALIGN, UNKNOWN);
    if (depth == 0 && result == ENOMEM) allocated(NULL, 0, size, POSIX_MEMALIGN, UNKNOWN);
    return result;
}

EXPORT("bun_memory_telemetry") const struct MemoryTelemetry *bun_memory_telemetry(void) {
    counters.capacity = capacity();
    return &counters;
}

EXPORT("bun_memory_failure_telemetry") const struct MemoryFailureTelemetry *bun_memory_failure_telemetry(void) {
    return &failure;
}

EXPORT("__libc_malloc") void *__wrap___libc_malloc(size_t size) {
    return __wrap_malloc(size);
}
EXPORT("__libc_calloc") void *__wrap___libc_calloc(size_t count, size_t size) {
    return __wrap_calloc(count, size);
}
EXPORT("__libc_free") void __wrap___libc_free(void *pointer) {
    __wrap_free(pointer);
}
