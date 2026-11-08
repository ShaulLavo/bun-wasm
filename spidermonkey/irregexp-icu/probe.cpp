// C2-only exports keep every adapter operation and all dynamic property paths
// live.
#include "property_data.h"
#include "unicode/uniset.h"
#include "unicode/usetiter.h"
#include "unicode/utf16.h"
#include <cstdint>

extern "C" uint32_t bunsm_icu_probe_property(int32_t property, int32_t value) {
  UErrorCode status = U_ZERO_ERROR;
  icu::UnicodeSet set;
  set.applyIntPropertyValue(static_cast<UProperty>(property), value, status);
  if (U_FAILURE(status))
    return 0xffffffff;
  uint32_t result = set.size();
  icu::UnicodeSetIterator iterator(set);
  iterator.skipToStrings();
  while (iterator.next()) {
    const auto &string = iterator.getString();
    for (int32_t i = 0; i < string.length();) {
      UChar32 cp;
      U16_NEXT(string.getBuffer(), i, string.length(), cp);
      result ^= u_foldCase(cp, U_FOLD_CASE_DEFAULT);
    }
  }
  set.closeOver(USET_SIMPLE_CASE_INSENSITIVE);
  set.removeAllStrings();
  for (int32_t i = 0; i < set.getRangeCount(); ++i)
    result ^= set.getRangeStart(i) ^ set.getRangeEnd(i);
  return result ^ set.hasStrings() ^ set.isEmpty();
}
extern "C" uint32_t bunsm_icu_probe_sets(int32_t first, int32_t last) {
  icu::UnicodeSet original(first, last);
  icu::UnicodeSet copy(original);
  icu::UnicodeSet assigned;
  assigned = original;
  copy.add(first).add(first, last).addAll(assigned);
  copy.remove(first, first);
  assigned.retainAll(copy);
  assigned.removeAll(original);
  assigned.complement().freeze();
  return assigned.size() ^ copy.contains(first) ^
         copy.containsSome(first, last) ^ copy.containsNone(assigned) ^
         copy.containsAll(original);
}
extern "C" int32_t bunsm_icu_probe_aliases(const char *property,
                                           const char *value) {
  UProperty id = u_getPropertyEnum(property);
  int32_t resolved = u_getPropertyValueEnum(id, value);
  return resolved ^ bunsm_icu_is_exact_property_alias(property, id) ^
         bunsm_icu_is_exact_property_value_alias(value, id, resolved) ^
         u_isalpha(resolved);
}
extern "C" uint32_t bunsm_icu_probe_all_properties() {
  uint32_t result = 0;
  for (const auto &info : bun_properties)
    result ^= bunsm_icu_probe_property(info.property, 1);
  return result;
}
