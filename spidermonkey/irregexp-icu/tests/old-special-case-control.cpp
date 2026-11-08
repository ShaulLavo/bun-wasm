// Preserve and execute the original generated support in a disjoint namespace.
#define v8 bunsm_old_v8
#include "../templates/special-case.cc"
#undef v8
extern "C" bool bunsm_icu_old_cpp_supplementary(uint32_t cp) {
  return bunsm_old_v8::internal::regexp::CaseFolding::
      HasSupplementaryEquivalents(static_cast<uint16_t>(cp));
}

extern "C" bool bunsm_icu_old_cpp_ignore(uint32_t cp) {
  static const icu::UnicodeSet ignore =
      bunsm_old_v8::internal::regexp::BuildIgnoreSet();
  return ignore.contains(cp);
}
