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
bsm_handle bsm_undefined(void);
bsm_handle bsm_null(void);
bsm_handle bsm_bool(uint8_t);
bsm_handle bsm_number_value(double);
bsm_handle bsm_string(const char*, size_t);
bsm_handle bsm_bigint(int64_t, uint8_t);
bsm_handle bsm_global(void);
bsm_handle bsm_uint8_array(const uint8_t*, size_t);
bool bsm_same_value(bsm_handle, bsm_handle);
bool bsm_define_hidden(bsm_handle, const char*, size_t, bsm_handle, bsm_handle*);
bsm_handle bsm_error(uint32_t, const char*, size_t);
uint32_t bsm_kind(bsm_handle);
bsm_handle bsm_dup(bsm_handle);
void bsm_release(bsm_handle);
double bsm_number(bsm_handle);
int64_t bsm_bigint_value(bsm_handle);
uint8_t bsm_bool_value(bsm_handle);
const char* bsm_string_data(bsm_handle, size_t*);
const uint8_t* bsm_bytes(bsm_handle, size_t*);
bsm_handle bsm_new_object(void);
bsm_handle bsm_new_array(size_t);
bool bsm_get(bsm_handle, const char*, size_t, bsm_handle*);
bool bsm_set(bsm_handle, const char*, size_t, bsm_handle, bsm_handle*);
bsm_handle bsm_keys(bsm_handle);
bool bsm_array_get(bsm_handle, uint32_t, bsm_handle*);
bool bsm_array_set(bsm_handle, uint32_t, bsm_handle);
bsm_handle bsm_function(const char*, size_t, uint32_t);
bool bsm_call(bsm_handle, bsm_handle, const bsm_handle*, size_t, bsm_handle*);
bool bsm_eval_script(const char*, size_t, const char*, int32_t, bsm_handle*);
bool bsm_eval_module(const char*, size_t, const char*, size_t, bsm_handle*);
bool bsm_import(const char*, size_t, bsm_handle*);
bool bsm_drain_jobs(bsm_handle*);
bool bsm_terminated(void);
void bunsm_host_free(char*);
int bsm_promise_state(bsm_handle);
bsm_handle bsm_promise_result(bsm_handle);
bool bsm_promise_then(bsm_handle, bsm_handle, bsm_handle, bsm_handle*);
bsm_handle bsm_external_buffer(uint8_t*, size_t);
bool bsm_detach_external(bsm_handle);
bool bsm_is_detachable_buffer(bsm_handle);
void bsm_detach_buffer(bsm_handle);
bool bsm_is_proxy(bsm_handle);
bsm_handle bsm_proxy_target(bsm_handle);
bool bsm_is_error(bsm_handle);
bsm_handle bsm_async_context(void);
void bsm_set_async_context(bsm_handle);
void bsm_gc(void);
void bsm_heap_info(double*, double*, double*);

bool bunsm_host_call(uint32_t, bsm_handle, const bsm_handle*, size_t, bsm_handle*);
void bunsm_host_drop(uint32_t);
bool bunsm_host_resolve(const char*, size_t, const char*, size_t, char**, size_t*, bsm_handle*);
bool bunsm_host_load(const char*, size_t, char**, size_t*, bsm_handle*);
bool bunsm_host_init_meta(const char*, size_t, bsm_handle, bsm_handle*);
bool bunsm_host_interrupt(void);
void bunsm_host_rejection(bsm_handle, bsm_handle, bool);
void bunsm_host_uncaught(bsm_handle);
#ifdef __cplusplus
[[noreturn]] void bunsm_host_fatal(const char*, size_t);
#else
_Noreturn void bunsm_host_fatal(const char*, size_t);
#endif
#ifdef __cplusplus
}
#endif
