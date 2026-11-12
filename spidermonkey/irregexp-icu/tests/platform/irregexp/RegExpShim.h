#ifndef BUNSM_SPECIAL_CASE_CONTROL_SHIM_H
#define BUNSM_SPECIAL_CASE_CONTROL_SHIM_H
#include <cassert>
#include <cstdint>
#define V8_EXPORT_PRIVATE
#define DCHECK(condition) assert(condition)
#define DCHECK_GE(left, right) assert((left) >= (right))
#define DCHECK_LE(left, right) assert((left) <= (right))
#define LAZY_INSTANCE_INITIALIZER                                              \
  {                                                                            \
  }
// Only the type/macro and static-initialization boundary is substituted. The
// generated sets and CaseFolding predicate bodies are the real pinned source.
namespace v8::internal {
class AllStatic {};
namespace base {
using uc16 = uint16_t;
template <class T> struct LazyInstance {
  struct type {
    T *Pointer() {
      static T value;
      return &value;
    }
  };
};
} // namespace base
} // namespace v8::internal
#endif
