#ifndef BUNSM_ICU_TEST_UTILITY_H
#define BUNSM_ICU_TEST_UTILITY_H
#include <cstddef>
#include <cstdio>
#include <cstdlib>
// Host-only allocator substitution. Production allocator.cpp still calls the
// exact AutoEnterOOMUnsafeRegion::crash entry point, not a special test branch.
namespace js {
struct AutoEnterOOMUnsafeRegion {
  [[noreturn]] void crash(const char *reason) {
    std::fprintf(stderr, "AutoEnterOOMUnsafeRegion::crash: %s\n", reason);
    std::_Exit(134);
  }
};
} // namespace js
template <class T> T *js_pod_malloc(size_t count) {
  return static_cast<T *>(std::malloc(count * sizeof(T)));
}
inline void js_free(void *pointer) { std::free(pointer); }
#endif
