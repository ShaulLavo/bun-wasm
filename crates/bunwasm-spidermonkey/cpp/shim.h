#pragma once
#include <stddef.h>
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
typedef uint32_t bsm_handle;
typedef struct {
  uintptr_t stack_low, stack_high;
  uint32_t max_gc_bytes;
  uint8_t tier, interruptible;
} bsm_config;
void bsm_init(const bsm_config*);
void bsm_shutdown(void);
bsm_handle bsm_eval(const char*, size_t, uint32_t*);
void bsm_release(bsm_handle);
double bsm_number(bsm_handle);
double bsm_answer(bsm_handle);
void bsm_gc(void);
uint32_t bsm_poll_count(uint8_t);
uint32_t bsm_pbl_entries(void);
void bsm_force_oom(void);
#ifdef __cplusplus
}
#endif
