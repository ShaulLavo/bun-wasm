#ifndef BUNWASM_ICU_USETITER_H
#define BUNWASM_ICU_USETITER_H
#include "unicode/uniset.h"
namespace icu {
// The compiled irregexp caller uses only skipToStrings()/next()/getString().
class UnicodeSetIterator {
public:
  explicit UnicodeSetIterator(const UnicodeSet &set) : set_(set) {}
  void skipToStrings() {
    strings_only_ = true;
    index_ = 0;
  }
  UBool next() {
    return strings_only_ && index_ < set_.stringCount() && (++index_, true);
  }
  const UnicodeString &getString() const { return set_.stringAt(index_ - 1); }

private:
  const UnicodeSet &set_;
  size_t index_ = 0;
  bool strings_only_ = false;
};
} // namespace icu
#endif
