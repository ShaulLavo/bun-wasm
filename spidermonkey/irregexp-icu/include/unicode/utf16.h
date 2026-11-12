#ifndef BUNWASM_ICU_UTF16_H
#define BUNWASM_ICU_UTF16_H

#include "unicode/utypes.h"

#define U16_IS_LEAD(c) ((uint16_t)(c) >= 0xd800 && (uint16_t)(c) <= 0xdbff)
#define U16_IS_TRAIL(c) ((uint16_t)(c) >= 0xdc00 && (uint16_t)(c) <= 0xdfff)
#define U16_GET_SUPPLEMENTARY(lead, trail)                                     \
  (((UChar32)(lead) << 10) + (UChar32)(trail) +                                \
   (0x10000 - (0xd800 << 10) - 0xdc00))
#define U16_NEXT(s, i, length, c)                                              \
  do {                                                                         \
    uint16_t __lead = (s)[(i)++];                                              \
    if (U16_IS_LEAD(__lead) && (i) < (length) && U16_IS_TRAIL((s)[i])) {       \
      (c) = U16_GET_SUPPLEMENTARY(__lead, (s)[(i)++]);                         \
    } else {                                                                   \
      (c) = __lead;                                                            \
    }                                                                          \
  } while (0)

#endif
