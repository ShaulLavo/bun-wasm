#include <stdint.h>
#include <stdlib.h>

extern int __main_void(void);
static volatile uint32_t constructors;

__attribute__((constructor)) static void record_constructor(void) {
    constructors++;
}

uint32_t bun_core_ctor_count(void) { return constructors; }

void _start(void) {
    if (constructors != 1) abort();
    exit(__main_void());
}
