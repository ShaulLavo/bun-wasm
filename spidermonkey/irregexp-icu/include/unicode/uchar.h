#ifndef BUNWASM_ICU_UCHAR_H
#define BUNWASM_ICU_UCHAR_H

#include "unicode/utypes.h"

#ifndef __cplusplus
#include <stdbool.h>
#endif

#ifdef __cplusplus
extern "C" {
#endif

#define BUNSM_UCHAR_ENUMS                                                      \
  X(UCHAR_ALPHABETIC, 0)                                                       \
  X(UCHAR_ASCII_HEX_DIGIT, 1)                                                  \
  X(UCHAR_BIDI_CONTROL, 2)                                                     \
  X(UCHAR_BIDI_MIRRORED, 3)                                                    \
  X(UCHAR_DASH, 4)                                                             \
  X(UCHAR_DEFAULT_IGNORABLE_CODE_POINT, 5)                                     \
  X(UCHAR_DEPRECATED, 6)                                                       \
  X(UCHAR_DIACRITIC, 7)                                                        \
  X(UCHAR_EXTENDER, 8)                                                         \
  X(UCHAR_GRAPHEME_BASE, 10)                                                   \
  X(UCHAR_GRAPHEME_EXTEND, 11)                                                 \
  X(UCHAR_HEX_DIGIT, 13)                                                       \
  X(UCHAR_ID_CONTINUE, 15)                                                     \
  X(UCHAR_ID_START, 16)                                                        \
  X(UCHAR_IDEOGRAPHIC, 17)                                                     \
  X(UCHAR_IDS_BINARY_OPERATOR, 18)                                             \
  X(UCHAR_IDS_TRINARY_OPERATOR, 19)                                            \
  X(UCHAR_JOIN_CONTROL, 20)                                                    \
  X(UCHAR_LOGICAL_ORDER_EXCEPTION, 21)                                         \
  X(UCHAR_LOWERCASE, 22)                                                       \
  X(UCHAR_MATH, 23)                                                            \
  X(UCHAR_NONCHARACTER_CODE_POINT, 24)                                         \
  X(UCHAR_QUOTATION_MARK, 25)                                                  \
  X(UCHAR_RADICAL, 26)                                                         \
  X(UCHAR_SOFT_DOTTED, 27)                                                     \
  X(UCHAR_TERMINAL_PUNCTUATION, 28)                                            \
  X(UCHAR_UNIFIED_IDEOGRAPH, 29)                                               \
  X(UCHAR_UPPERCASE, 30)                                                       \
  X(UCHAR_WHITE_SPACE, 31)                                                     \
  X(UCHAR_XID_CONTINUE, 32)                                                    \
  X(UCHAR_XID_START, 33)                                                       \
  X(UCHAR_S_TERM, 35)                                                          \
  X(UCHAR_VARIATION_SELECTOR, 36)                                              \
  X(UCHAR_PATTERN_SYNTAX, 42)                                                  \
  X(UCHAR_PATTERN_WHITE_SPACE, 43)                                             \
  X(UCHAR_CASED, 49)                                                           \
  X(UCHAR_CASE_IGNORABLE, 50)                                                  \
  X(UCHAR_CHANGES_WHEN_LOWERCASED, 51)                                         \
  X(UCHAR_CHANGES_WHEN_UPPERCASED, 52)                                         \
  X(UCHAR_CHANGES_WHEN_TITLECASED, 53)                                         \
  X(UCHAR_CHANGES_WHEN_CASEFOLDED, 54)                                         \
  X(UCHAR_CHANGES_WHEN_CASEMAPPED, 55)                                         \
  X(UCHAR_CHANGES_WHEN_NFKC_CASEFOLDED, 56)                                    \
  X(UCHAR_EMOJI, 57)                                                           \
  X(UCHAR_EMOJI_PRESENTATION, 58)                                              \
  X(UCHAR_EMOJI_MODIFIER, 59)                                                  \
  X(UCHAR_EMOJI_MODIFIER_BASE, 60)                                             \
  X(UCHAR_EMOJI_COMPONENT, 61)                                                 \
  X(UCHAR_REGIONAL_INDICATOR, 62)                                              \
  X(UCHAR_EXTENDED_PICTOGRAPHIC, 64)                                           \
  X(UCHAR_BASIC_EMOJI, 65)                                                     \
  X(UCHAR_EMOJI_KEYCAP_SEQUENCE, 66)                                           \
  X(UCHAR_RGI_EMOJI_MODIFIER_SEQUENCE, 67)                                     \
  X(UCHAR_RGI_EMOJI_FLAG_SEQUENCE, 68)                                         \
  X(UCHAR_RGI_EMOJI_TAG_SEQUENCE, 69)                                          \
  X(UCHAR_RGI_EMOJI_ZWJ_SEQUENCE, 70)                                          \
  X(UCHAR_RGI_EMOJI, 71)

enum UPropertyEnum {
  UCHAR_INVALID_CODE = -1,
#define X(name, value) name = value,
  BUNSM_UCHAR_ENUMS
#undef X
      UCHAR_GENERAL_CATEGORY = 0x1005,
  UCHAR_SCRIPT = 0x100A,
  UCHAR_GENERAL_CATEGORY_MASK = 0x2000,
  UCHAR_SCRIPT_EXTENSIONS = 0x7000,
};

typedef enum UPropertyEnum UProperty;

UChar32 u_foldCase(UChar32 c, uint32_t options);
UBool u_isalpha(UChar32 c);
UProperty u_getPropertyEnum(const char *name);
int32_t u_getPropertyValueEnum(UProperty property, const char *name);
bool bunsm_icu_is_exact_property_alias(const char *name, int32_t property);
bool bunsm_icu_is_exact_property_value_alias(const char *name, int32_t property,
                                             int32_t value);

#ifdef __cplusplus
}
#endif

#endif
