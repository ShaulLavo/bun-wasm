#include "js/Utility.h"
#include "unicode/unistr.h"

#ifdef BUNSM_ICU_CONTROLS
static int32_t fail_after = -1;
extern "C" void bunsm_icu_fail_after(int32_t count) { fail_after = count; }
#endif

namespace icu::detail {
void *allocate(size_t bytes) {
  js::AutoEnterOOMUnsafeRegion unsafe;
#ifdef BUNSM_ICU_CONTROLS
  if (fail_after == 0)
    unsafe.crash("bunwasm ICU subset allocation failure");
  if (fail_after > 0)
    --fail_after;
#endif
  void *result = js_pod_malloc<uint8_t>(bytes);
  if (!result)
    unsafe.crash("bunwasm ICU subset allocation failure");
  return result;
}
void deallocate(void *pointer) { js_free(pointer); }
} // namespace icu::detail
