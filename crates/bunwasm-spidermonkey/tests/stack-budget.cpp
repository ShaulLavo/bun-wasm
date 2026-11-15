#include "stack-budget.h"
#include <stdio.h>

int main() {
  constexpr size_t available = 8 * 1024 * 1024 - 65536;
  struct Case { const char* value; size_t expected; };
  const Case cases[] = {
      {nullptr, available}, {"", available}, {"0", available}, {"000", available},
      {"-1", available}, {"+1", available}, {" 32", available}, {"32 ", available},
      {"32.0", available}, {"32KiB", available}, {"1e3", available}, {"0x20", available},
      {"1", 1024}, {"0032", 32 * 1024}, {"35", 35 * 1024},
      {"7168", 7 * 1024 * 1024}, {"7169", 7 * 1024 * 1024},
      {"999999999999999999999999999999999999999", 7 * 1024 * 1024},
      {"99999999999999999999999999999999999999x", available},
  };
  // The QuickJS and JSC budget never reaches SpiderMonkey's quota.
  setenv("BUN_WASM_STACK_KIB", "32", 1);
  for (const auto& item : cases) {
    if (item.value) setenv(BUNSM_STACK_KIB_ENV, item.value, 1);
    else unsetenv(BUNSM_STACK_KIB_ENV);
    if (bunsm_stack_quota(available) != item.expected) {
      fprintf(stderr, "wrong quota for %s\n", item.value ? item.value : "unset");
      return 1;
    }
  }
  setenv(BUNSM_STACK_KIB_ENV, "7168", 1);
  if (bunsm_stack_quota(32768) != 32768) return 1;
  puts("ok positive decimal quotas, saturation, invalid input, member bounds and its own variable");
}
