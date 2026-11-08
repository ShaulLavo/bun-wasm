#include "unicode/uchar.h"
#include "ucd.h"

extern "C" bool bunsm_ucd_property_ranges(uint32_t, const char *, int32_t,
                                          BunRangeSink, BunStringSink, void *) {
  return false;
}
extern "C" uint32_t bunsm_ucd_simple_fold(uint32_t cp) { return cp; }
extern "C" bool bunsm_ucd_is_letter(uint32_t) { return false; }
extern "C" void bunsm_ucd_close_over_scf(const BunCodePointRange *, size_t,
                                         BunRangeSink, void *) {}
extern "C" bool bunsm_ucd_value_enum(uint32_t, const char *, int32_t *) {
  return false;
}

static bool invalid_property(const char *name) {
  const UProperty property = u_getPropertyEnum(name);
  return property == UCHAR_INVALID_CODE &&
         !bunsm_icu_is_exact_property_alias(name, property);
}

int main() {
  if (!invalid_property(nullptr) || !invalid_property("NotAProperty") ||
      !invalid_property("") || !invalid_property("id_start"))
    return 1;
  return u_getPropertyEnum("ID_Start") == UCHAR_ID_START ? 0 : 1;
}
