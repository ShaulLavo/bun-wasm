#pragma once
#include <stddef.h>
#include <stdlib.h>

inline size_t bunsm_stack_quota(size_t available) {
  const char* value = getenv("BUN_WASM_STACK_KIB");
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
