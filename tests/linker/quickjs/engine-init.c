#include <stdint.h>
#include <stdlib.h>

static volatile uint32_t initialized;
static volatile uint32_t seed = 42;
static volatile uint32_t *volatile relocated_seed = &seed;

__attribute__((constructor)) static void initialize_fixture(void) {
    uint32_t *value = malloc(sizeof(uint32_t));
    if (!value) abort();
    *value = *relocated_seed;
    initialized += *value;
    free(value);
}

uint32_t quickjs_ctor_value(void) { return initialized; }
