#include "../property_data.h"
#include "../ucd.h"
#include "unicode/uniset.h"
#include "unicode/usetiter.h"
#include "unicode/utf16.h"
#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <initializer_list>

extern "C" void bunsm_icu_fail_after(int32_t);
namespace {
void require(bool value, const char *name) {
  if (value)
    return;
  std::fprintf(stderr, "Unicode adapter control failed: %s\n", name);
  std::abort();
}
void invalid_inputs() {
  require(u_getPropertyEnum(nullptr) == UCHAR_INVALID_CODE &&
              u_getPropertyEnum("NotAProperty") == UCHAR_INVALID_CODE,
          "null and unknown property names");
  icu::UnicodeSet set;
  UErrorCode status = U_ZERO_ERROR;
  set.applyIntPropertyValue(static_cast<UProperty>(-1), 1, status);
  require(status == U_ILLEGAL_ARGUMENT_ERROR, "unknown property");
  status = U_ZERO_ERROR;
  set.applyIntPropertyValue(UCHAR_ID_START, 4, status);
  require(status == U_ILLEGAL_ARGUMENT_ERROR, "unknown binary value");
  status = U_ZERO_ERROR;
  set.applyIntPropertyValue(UCHAR_SCRIPT, 0xffff, status);
  require(status == U_ILLEGAL_ARGUMENT_ERROR, "unknown script value");
  for (int32_t property = UCHAR_BASIC_EMOJI; property <= UCHAR_RGI_EMOJI;
       ++property) {
    status = U_ZERO_ERROR;
    set.applyIntPropertyValue(static_cast<UProperty>(property), 0, status);
    require(status == U_ILLEGAL_ARGUMENT_ERROR, "string property has no N");
  }
}
void empty_and_string_sets() {
  UErrorCode status = U_ZERO_ERROR;
  icu::UnicodeSet empty;
  // A zero general-category mask is valid and empty, unlike an unknown enum.
  empty.applyIntPropertyValue(UCHAR_GENERAL_CATEGORY_MASK, 0, status);
  require(U_SUCCESS(status) && empty.isEmpty(), "valid empty");
  empty.complement();
  require(empty.size() == 0x110000 && empty.contains(0xd800) &&
              empty.contains(0x10ffff),
          "empty complement");
  empty.complement();
  require(empty.isEmpty(), "Any complement is empty");
  icu::UnicodeSet strings;
  strings.applyIntPropertyValue(UCHAR_BASIC_EMOJI, 1, status);
  require(U_SUCCESS(status) && strings.hasStrings(),
          "real Basic_Emoji strings");
  strings.remove(0, UCHAR_MAX_VALUE);
  require(strings.getRangeCount() == 0 && strings.hasStrings() &&
              !strings.isEmpty(),
          "valid string-only");
  icu::UnicodeSetIterator iterator(strings);
  iterator.skipToStrings();
  bool heart = false;
  while (iterator.next()) {
    const auto &string = iterator.getString();
    const auto *units = string.getBuffer();
    heart |= string.length() == 2 && units[0] == 0x2764 && units[1] == 0xfe0f;
  }
  require(heart, "heart plus variation selector");
  icu::UnicodeSet kept(strings);
  kept.retainAll(strings);
  require(kept.containsAll(strings), "string intersection");
  kept.removeAll(strings);
  require(kept.isEmpty(), "string subtraction");
}
bool has_string(const icu::UnicodeSet &set,
                std::initializer_list<char16_t> expected) {
  icu::UnicodeSetIterator iterator(set);
  iterator.skipToStrings();
  while (iterator.next()) {
    const auto &string = iterator.getString();
    if (size_t(string.length()) == expected.size() &&
        std::equal(expected.begin(), expected.end(), string.getBuffer()))
      return true;
  }
  return false;
}
icu::UnicodeSet string_property(UProperty property) {
  UErrorCode status = U_ZERO_ERROR;
  icu::UnicodeSet set;
  set.applyIntPropertyValue(property, 1, status);
  require(U_SUCCESS(status) && set.hasStrings() && !set.isEmpty(),
          "U2 property of strings is valid and nonempty");
  return set;
}
void string_properties() {
  auto keycap = string_property(UCHAR_EMOJI_KEYCAP_SEQUENCE);
  require(keycap.getRangeCount() == 0 &&
              has_string(keycap, {'#', 0xfe0f, 0x20e3}),
          "keycap number sign");
  auto modifier = string_property(UCHAR_RGI_EMOJI_MODIFIER_SEQUENCE);
  require(has_string(modifier, {0x261d, 0xd83c, 0xdffb}),
          "BMP base with light skin tone");
  auto flag = string_property(UCHAR_RGI_EMOJI_FLAG_SEQUENCE);
  require(has_string(flag, {0xd83c, 0xddee, 0xd83c, 0xddf1}), "flag IL");
  auto tag = string_property(UCHAR_RGI_EMOJI_TAG_SEQUENCE);
  require(has_string(tag, {0xd83c, 0xdff4, 0xdb40, 0xdc67, 0xdb40, 0xdc62,
                           0xdb40, 0xdc65, 0xdb40, 0xdc6e, 0xdb40, 0xdc67,
                           0xdb40, 0xdc7f}),
          "England tag sequence");
  auto zwj = string_property(UCHAR_RGI_EMOJI_ZWJ_SEQUENCE);
  require(has_string(zwj, {0xd83d, 0xdc68, 0x200d, 0xd83d, 0xdc69, 0x200d,
                           0xd83d, 0xdc67, 0x200d, 0xd83d, 0xdc66}),
          "family ZWJ sequence");
  auto rgi = string_property(UCHAR_RGI_EMOJI);
  require(rgi.contains(0x231a) && has_string(rgi, {0x2764, 0xfe0f}) &&
              rgi.containsAll(keycap) && rgi.containsAll(modifier) &&
              rgi.containsAll(flag) && rgi.containsAll(tag) &&
              rgi.containsAll(zwj),
          "RGI_Emoji is Basic_Emoji plus every sequence property");
}
void set_operations() {
  icu::UnicodeSet left(1, 3);
  left.add(5, 7).add(4).add(0);
  require(left.getRangeCount() == 1 && left.size() == 8, "range coalescing");
  left.remove(2, 5);
  require(left.getRangeCount() == 2 && left.contains(1) && !left.contains(2),
          "range split");
  icu::UnicodeSet right(0, 1);
  require(left.containsAll(right) && !left.containsNone(right), "containment");
  left.retainAll(icu::UnicodeSet(1, 6));
  require(left.size() == 2 && left.contains(1) && left.contains(6),
          "intersection");
  left.removeAll(left);
  require(left.isEmpty(), "self subtraction");
  left.add('k').closeOver(USET_SIMPLE_CASE_INSENSITIVE);
  require(left.contains('K') && left.contains(0x212a), "Kelvin closure");
  require(!left.contains(0x130) && u_foldCase(0x130, 0) == 0x130,
          "non-Turkic fold");
  const char16_t units[] = {0xd801, 0xdc00, 0xd800, 'a', 0xdc00};
  int32_t index = 0;
  UChar32 cp = 0;
  U16_NEXT(units, index, 5, cp);
  require(cp == 0x10400 && index == 2, "UTF16 pair");
  U16_NEXT(units, index, 5, cp);
  require(cp == 0xd800 && index == 3, "UTF16 unpaired lead");
}
void aliases() {
  size_t count = 0;
  for (const auto &info : bun_properties) {
    require(u_getPropertyEnum(info.name) == info.property,
            "long property alias");
    require(u_getPropertyEnum(info.short_name) == info.property,
            "short property alias");
    require(bunsm_icu_is_exact_property_alias(info.name, info.property),
            "exact property alias");
    if (info.property < UCHAR_BASIC_EMOJI) {
      UErrorCode status = U_ZERO_ERROR;
      icu::UnicodeSet set;
      set.applyIntPropertyValue(info.property, 1, status);
      require(U_SUCCESS(status), "all 50 binary property backends");
    }
    ++count;
  }
  require(count == 60, "all supported property names");
  require(u_getPropertyEnum("space") == UCHAR_WHITE_SPACE &&
              bunsm_icu_is_exact_property_alias("space", UCHAR_WHITE_SPACE) &&
              u_getPropertyEnum("Space") == UCHAR_INVALID_CODE,
          "ECMAScript White_Space aliases");
  require(u_getPropertyEnum("WSpace") == UCHAR_INVALID_CODE &&
              !bunsm_icu_is_exact_property_alias("WSpace", UCHAR_WHITE_SPACE),
          "ECMAScript rejects ICU-only WSpace alias");
  require(u_getPropertyEnum("id_start") == -1 &&
              u_getPropertyEnum("Block") == -1,
          "unsupported and loose names");
  require(u_getPropertyValueEnum(UCHAR_SCRIPT, "Greek_") == -1,
          "loose script value");
  require(u_getPropertyValueEnum(UCHAR_GENERAL_CATEGORY_MASK, "lu") == -1,
          "loose gc value");
  require(bunsm_icu_is_exact_property_value_alias(
              "digit", UCHAR_GENERAL_CATEGORY_MASK, 1 << 9),
          "extra gc alias");
}
} // namespace
extern "C" int bunsm_icu_host_controls() {
  invalid_inputs();
  empty_and_string_sets();
  set_operations();
  aliases();
  string_properties();
  return 5;
}
extern "C" void bunsm_icu_host_oom() {
  bunsm_icu_fail_after(0);
  icu::UnicodeSet set;
  set.add(1);
  std::abort();
}
namespace {
// u-mode LookupPropertyValueName at the Mozilla pin, through the adapter.
bool lookup_value(UProperty property, const char *value, bool negate,
                  icu::UnicodeSet &out) {
  UProperty lookup =
      property == UCHAR_SCRIPT_EXTENSIONS ? UCHAR_SCRIPT : property;
  int32_t number = u_getPropertyValueEnum(lookup, value);
  if (number == UCHAR_INVALID_CODE ||
      !bunsm_icu_is_exact_property_value_alias(value, lookup, number))
    return false;
  UErrorCode status = U_ZERO_ERROR;
  out.applyIntPropertyValue(property, number, status);
  if (U_FAILURE(status))
    return false;
  out.removeAllStrings();
  if (negate)
    out.complement();
  return true;
}
bool lookup_special(const char *name, bool negate, icu::UnicodeSet &out) {
  if (std::strcmp(name, "Any") == 0) {
    if (!negate)
      out.add(0, UCHAR_MAX_VALUE);
    return true;
  }
  if (std::strcmp(name, "ASCII") == 0) {
    out.add(0, 0x7f);
    if (negate)
      out.complement();
    return true;
  }
  if (std::strcmp(name, "Assigned") == 0)
    return lookup_value(UCHAR_GENERAL_CATEGORY_MASK, "Unassigned", !negate,
                        out);
  return false;
}
// u-mode AddPropertyClassRange at the Mozilla pin, without properties of
// strings, which u mode rejects.
bool lookup_lone(const char *name, bool negate, icu::UnicodeSet &out) {
  if (lookup_value(UCHAR_GENERAL_CATEGORY_MASK, name, negate, out))
    return true;
  out = icu::UnicodeSet();
  if (lookup_special(name, negate, out))
    return true;
  UProperty property = u_getPropertyEnum(name);
  if (property < 0 || property >= UCHAR_BASIC_EMOJI ||
      !bunsm_icu_is_exact_property_alias(name, property))
    return false;
  return lookup_value(property, negate ? "N" : "Y", false, out);
}
} // namespace
extern "C" bool bunsm_icu_host_lookup(const char *name, const char *value,
                                      bool negate, BunRangeSink sink,
                                      void *context) {
  icu::UnicodeSet set;
  bool ok = false;
  if (!*value) {
    ok = lookup_lone(name, negate, set);
  } else {
    UProperty property = u_getPropertyEnum(name);
    if (property == UCHAR_GENERAL_CATEGORY)
      property = UCHAR_GENERAL_CATEGORY_MASK;
    bool enumerated = property == UCHAR_GENERAL_CATEGORY_MASK ||
                      property == UCHAR_SCRIPT ||
                      property == UCHAR_SCRIPT_EXTENSIONS;
    ok = enumerated &&
         bunsm_icu_is_exact_property_alias(name, u_getPropertyEnum(name)) &&
         lookup_value(property, value, negate, set);
  }
  for (int32_t i = 0; ok && i < set.getRangeCount(); ++i)
    sink(context, set.getRangeStart(i), set.getRangeEnd(i));
  return ok;
}
extern "C" int32_t bunsm_icu_alias_value(int32_t property, const char *name) {
  return u_getPropertyValueEnum(static_cast<UProperty>(property), name);
}
extern "C" void js_irregexp_add_range_to_zone_list(void *list, void *zone,
                                                   uint32_t first,
                                                   uint32_t last) {
  auto callback = *static_cast<BunRangeSink *>(zone);
  callback(list, first, last);
}
