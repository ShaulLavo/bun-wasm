#ifndef BUNWASM_ICU_UNISET_H
#define BUNWASM_ICU_UNISET_H

#include "unicode/uchar.h"
#include "unicode/unistr.h"
#include <utility>

namespace icu {
class UnicodeSet {
public:
  UnicodeSet() = default;
  UnicodeSet(UChar32 first, UChar32 last) { add(first, last); }
  UnicodeSet &add(UChar32 c) { return add(c, c); }
  UnicodeSet &add(UChar32 first, UChar32 last);
  UnicodeSet &addAll(const UnicodeSet &other);
  UnicodeSet &remove(UChar32 first, UChar32 last);
  UnicodeSet &removeAll(const UnicodeSet &other);
  UnicodeSet &retainAll(const UnicodeSet &other);
  UnicodeSet &complement();
  UnicodeSet &closeOver(uint32_t options);
  UnicodeSet &removeAllStrings() {
    strings_.clear();
    return *this;
  }
  UnicodeSet &applyIntPropertyValue(UProperty property, int32_t value,
                                    UErrorCode &status);
  UnicodeSet &freeze() { return *this; }
  UBool contains(UChar32 c) const;
  UBool containsSome(UChar32 first, UChar32 last) const;
  UBool containsNone(const UnicodeSet &other) const;
  UBool containsAll(const UnicodeSet &other) const;
  UBool isEmpty() const { return ranges_.empty() && strings_.empty(); }
  int32_t size() const;
  int32_t getRangeCount() const { return static_cast<int32_t>(ranges_.size()); }
  UChar32 getRangeStart(int32_t index) const { return ranges_[index].first; }
  UChar32 getRangeEnd(int32_t index) const { return ranges_[index].last; }
  UBool hasStrings() const { return !strings_.empty(); }

  void addString(const UnicodeString &value);
  // Property queries emit each string once, so they skip addString's lookup.
  void appendDistinctString(UnicodeString &&value) {
    strings_.push_back(std::move(value));
  }
  size_t stringCount() const { return strings_.size(); }
  const UnicodeString &stringAt(size_t index) const { return strings_[index]; }

private:
  struct Range {
    UChar32 first;
    UChar32 last;
  };
  detail::Vector<Range> ranges_;
  detail::Vector<UnicodeString> strings_;
};
} // namespace icu
#endif
