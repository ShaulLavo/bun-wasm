#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <malloc.h>
#include <errno.h>
#include <stdio.h>
#include <time.h>

uint32_t core_usable(void *ptr) {
    return malloc_usable_size(ptr);
}


typedef int (*stack_callback)(uint32_t depth);

__attribute__((noinline)) int core_stack_reenter(uint32_t callback, uint32_t depth) {
    volatile uint32_t sentinel[64];
    for (uint32_t i = 0; i < 64; i++) sentinel[i] = depth + i;
    int result = depth ? ((stack_callback)callback)(depth - 1) : 0;
    for (uint32_t i = 0; i < 64; i++) {
        if (sentinel[i] != depth + i) return -1000;
    }
    return result + 1;
}

__attribute__((import_module("runtime_proc"), import_name("signal")))
extern uint32_t host_signal(uint32_t signal, uint32_t mode);
uint32_t core_checkpoint(void) { return host_signal(0, 4); }
uint32_t core_clock_address(void) { return (uintptr_t)CLOCK_MONOTONIC; }
int core_clock_smoke(void) {
    struct timespec now;
    return clock_gettime(CLOCK_MONOTONIC, &now) == 0 && now.tv_sec >= 0;
}
int core_errno_smoke(void) { errno = 47; return errno; }
uint32_t core_stdout_value(void) { return (uintptr_t)stdout; }
void _start(void) {}
