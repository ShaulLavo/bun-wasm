#include "irregexp/imported/special-case.h"
namespace v8::internal::regexp {
icu::UnicodeSet BuildIgnoreSet();
}
extern "C" bool bunsm_icu_cpp_supplementary(uint32_t cp) {
  return v8::internal::regexp::CaseFolding::HasSupplementaryEquivalents(
      static_cast<uint16_t>(cp));
}
extern "C" bool bunsm_icu_cpp_ignore(uint32_t cp) {
  static const icu::UnicodeSet ignore = v8::internal::regexp::BuildIgnoreSet();
  return ignore.contains(cp);
}
