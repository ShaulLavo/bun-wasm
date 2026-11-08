#ifndef BUNWASM_ICU_UNISTR_H
#define BUNWASM_ICU_UNISTR_H

#include "unicode/utypes.h"
#include <cstddef>
#include <vector>

namespace icu {
namespace detail {
void *allocate(size_t bytes);
void deallocate(void *pointer);

template <class T> struct Allocator {
  using value_type = T;
  Allocator() = default;
  template <class U> Allocator(const Allocator<U> &) {}
  T *allocate(size_t count) {
    return static_cast<T *>(detail::allocate(count * sizeof(T)));
  }
  void deallocate(T *pointer, size_t) { detail::deallocate(pointer); }
  template <class U> bool operator==(const Allocator<U> &) const {
    return true;
  }
};
template <class T> using Vector = std::vector<T, Allocator<T>>;
} // namespace detail

class UnicodeString {
public:
  UnicodeString() = default;
  UnicodeString(const char16_t *data, int32_t length)
      : units_(data, data + length) {}
  const char16_t *getBuffer() const { return units_.data(); }
  int32_t length() const { return static_cast<int32_t>(units_.size()); }
  bool operator==(const UnicodeString &other) const {
    return units_ == other.units_;
  }

private:
  detail::Vector<char16_t> units_;
};
} // namespace icu
#endif
