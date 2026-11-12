#include "unicode/uniset.h"
#include "unicode/usetiter.h"
#include <algorithm>

#include "property_data.h"
#include "ucd.h"
#include <cstring>

namespace {
const BunPropertyInfo *property_info(UProperty property);
void range_sink(void *context, uint32_t first, uint32_t last) {
  static_cast<icu::UnicodeSet *>(context)->add(first, last);
}
void string_sink(void *context, const uint16_t *units, size_t length) {
  static_cast<icu::UnicodeSet *>(context)->appendDistinctString(
      icu::UnicodeString(reinterpret_cast<const char16_t *>(units),
                         static_cast<int32_t>(length)));
}
} // namespace

namespace icu {
UnicodeSet &UnicodeSet::add(UChar32 first, UChar32 last) {
  first = std::max(first, 0);
  last = std::min(last, UCHAR_MAX_VALUE);
  if (first > last)
    return *this;
  auto begin = std::lower_bound(
      ranges_.begin(), ranges_.end(), first,
      [](const Range &range, UChar32 cp) { return range.last + 1 < cp; });
  auto end = begin;
  while (end != ranges_.end() && end->first <= last + 1) {
    first = std::min(first, end->first);
    last = std::max(last, end->last);
    ++end;
  }
  begin = ranges_.erase(begin, end);
  ranges_.insert(begin, {first, last});
  return *this;
}
void UnicodeSet::addString(const UnicodeString &value) {
  if (std::find(strings_.begin(), strings_.end(), value) != strings_.end())
    return;
  strings_.push_back(value);
}
UnicodeSet &UnicodeSet::addAll(const UnicodeSet &other) {
  if (this == &other)
    return *this;
  for (const auto &range : other.ranges_)
    add(range.first, range.last);
  for (const auto &string : other.strings_)
    addString(string);
  return *this;
}
UnicodeSet &UnicodeSet::remove(UChar32 first, UChar32 last) {
  if (first > last)
    return *this;
  detail::Vector<Range> result;
  for (const auto &range : ranges_) {
    if (range.last < first || range.first > last) {
      result.push_back(range);
      continue;
    }
    if (range.first < first)
      result.push_back({range.first, first - 1});
    if (range.last > last)
      result.push_back({last + 1, range.last});
  }
  ranges_.swap(result);
  return *this;
}
UnicodeSet &UnicodeSet::removeAll(const UnicodeSet &other) {
  if (this == &other) {
    ranges_.clear();
    strings_.clear();
    return *this;
  }
  for (const auto &range : other.ranges_)
    remove(range.first, range.last);
  std::erase_if(strings_, [&](const UnicodeString &string) {
    return std::find(other.strings_.begin(), other.strings_.end(), string) !=
           other.strings_.end();
  });
  return *this;
}
UnicodeSet &UnicodeSet::retainAll(const UnicodeSet &other) {
  if (this == &other)
    return *this;
  detail::Vector<Range> result;
  size_t right = 0;
  for (const auto &left : ranges_) {
    while (right < other.ranges_.size() &&
           other.ranges_[right].last < left.first)
      ++right;
    for (size_t j = right;
         j < other.ranges_.size() && other.ranges_[j].first <= left.last; ++j) {
      result.push_back({std::max(left.first, other.ranges_[j].first),
                        std::min(left.last, other.ranges_[j].last)});
    }
  }
  ranges_.swap(result);
  std::erase_if(strings_, [&](const UnicodeString &string) {
    return std::find(other.strings_.begin(), other.strings_.end(), string) ==
           other.strings_.end();
  });
  return *this;
}
UnicodeSet &UnicodeSet::complement() {
  detail::Vector<Range> result;
  UChar32 cursor = 0;
  for (const auto &range : ranges_) {
    if (cursor < range.first)
      result.push_back({cursor, range.first - 1});
    cursor = range.last + 1;
  }
  if (cursor <= UCHAR_MAX_VALUE)
    result.push_back({cursor, UCHAR_MAX_VALUE});
  ranges_.swap(result);
  // ICU code-point complement leaves existing string members unchanged.
  return *this;
}
UnicodeSet &UnicodeSet::closeOver(uint32_t options) {
  if (!(options & USET_SIMPLE_CASE_INSENSITIVE))
    return *this;
  detail::Vector<BunCodePointRange> ranges;
  ranges.reserve(ranges_.size());
  for (const auto &range : ranges_)
    ranges.push_back({uint32_t(range.first), uint32_t(range.last)});
  bunsm_ucd_close_over_scf(ranges.data(), ranges.size(), range_sink, this);
  return *this;
}
UnicodeSet &UnicodeSet::applyIntPropertyValue(UProperty property, int32_t value,
                                              UErrorCode &status) {
  if (U_FAILURE(status))
    return *this;
  const auto *info = property_info(property);
  if (!info) {
    status = U_ILLEGAL_ARGUMENT_ERROR;
    return *this;
  }
  UnicodeSet result;
  if (!bunsm_ucd_property_ranges(property, info->name, value, range_sink,
                                 string_sink, &result)) {
    status = U_ILLEGAL_ARGUMENT_ERROR;
    return *this;
  }
  ranges_.swap(result.ranges_);
  strings_.swap(result.strings_);
  return *this;
}
UBool UnicodeSet::contains(UChar32 cp) const {
  auto found = std::lower_bound(
      ranges_.begin(), ranges_.end(), cp,
      [](const Range &range, UChar32 value) { return range.last < value; });
  return found != ranges_.end() && found->first <= cp;
}
UBool UnicodeSet::containsSome(UChar32 first, UChar32 last) const {
  if (first > last)
    return false;
  auto found = std::lower_bound(
      ranges_.begin(), ranges_.end(), first,
      [](const Range &range, UChar32 value) { return range.last < value; });
  return found != ranges_.end() && found->first <= last;
}
UBool UnicodeSet::containsNone(const UnicodeSet &other) const {
  for (const auto &range : other.ranges_) {
    if (containsSome(range.first, range.last))
      return false;
  }
  for (const auto &string : other.strings_) {
    if (std::find(strings_.begin(), strings_.end(), string) != strings_.end())
      return false;
  }
  return true;
}
UBool UnicodeSet::containsAll(const UnicodeSet &other) const {
  for (const auto &range : other.ranges_) {
    auto found = std::lower_bound(
        ranges_.begin(), ranges_.end(), range.first,
        [](const Range &item, UChar32 value) { return item.last < value; });
    if (found == ranges_.end() || found->first > range.first ||
        found->last < range.last)
      return false;
  }
  for (const auto &string : other.strings_) {
    if (std::find(strings_.begin(), strings_.end(), string) == strings_.end())
      return false;
  }
  return true;
}
int32_t UnicodeSet::size() const {
  int32_t result = static_cast<int32_t>(strings_.size());
  for (const auto &range : ranges_)
    result += range.last - range.first + 1;
  return result;
}
} // namespace icu

extern "C" UChar32 u_foldCase(UChar32 cp, uint32_t) {
  return bunsm_ucd_simple_fold(cp);
}
extern "C" UBool u_isalpha(UChar32 cp) { return bunsm_ucd_is_letter(cp); }

namespace {
const BunPropertyInfo *property_info(UProperty property) {
  if (property == UCHAR_GENERAL_CATEGORY_MASK)
    property = UCHAR_GENERAL_CATEGORY;
  for (const auto &info : bun_properties) {
    if (info.property == property)
      return &info;
  }
  return nullptr;
}
} // namespace

extern "C" UProperty u_getPropertyEnum(const char *name) {
  if (!name)
    return static_cast<UProperty>(UCHAR_INVALID_CODE);
  for (const auto &info : bun_properties) {
    if (std::strcmp(name, info.name) == 0 ||
        std::strcmp(name, info.short_name) == 0)
      return info.property;
  }
  return static_cast<UProperty>(UCHAR_INVALID_CODE);
}
extern "C" int32_t u_getPropertyValueEnum(UProperty property,
                                          const char *name) {
  if (!property_info(property))
    return UCHAR_INVALID_CODE;
  int32_t value = UCHAR_INVALID_CODE;
  bunsm_ucd_value_enum(property, name, &value);
  return value;
}
extern "C" bool bunsm_icu_is_exact_property_alias(const char *name,
                                                  int32_t property) {
  return name && property != UCHAR_INVALID_CODE &&
         u_getPropertyEnum(name) == property;
}
extern "C" bool bunsm_icu_is_exact_property_value_alias(const char *name,
                                                        int32_t property,
                                                        int32_t value) {
  return value != UCHAR_INVALID_CODE &&
         u_getPropertyValueEnum(static_cast<UProperty>(property), name) ==
             value;
}
