#pragma once
#include <stddef.h>
#include <stdlib.h>

// SpiderMonkey's own budget. Its shadow-stack quota means something different from the
// QuickJS and JSC budget in BUN_WASM_STACK_KIB, which this engine never reads: a value sized
// for those engines (32 KiB) is below what SpiderMonkey needs to start.
#define BUNSM_STACK_KIB_ENV "BUN_WASM_SPIDERMONKEY_STACK_KIB"

inline size_t bunsm_stack_quota(size_t available) {
  const char* value = getenv(BUNSM_STACK_KIB_ENV);
  if (!value || !*value) return available;
  constexpr size_t maxKib = 7 * 1024;
  size_t kib = 0;
  for (const char* digit = value; *digit; ++digit) {
    if (*digit < '0' || *digit > '9') return available;
    kib = kib >= maxKib ? maxKib : kib * 10 + (*digit - '0');
  }
  if (!kib) return available;
  const size_t bytes = (kib < maxKib ? kib : maxKib) * 1024;
  return bytes < available ? bytes : available;
}
