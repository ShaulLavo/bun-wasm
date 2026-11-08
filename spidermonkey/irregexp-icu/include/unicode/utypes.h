#ifndef BUNWASM_ICU_UTYPES_H
#define BUNWASM_ICU_UTYPES_H

#include <stddef.h>
#include <stdint.h>

typedef int8_t UBool;
typedef int32_t UChar32;
typedef int32_t UErrorCode;

enum {
  U_ZERO_ERROR = 0,
  U_ILLEGAL_ARGUMENT_ERROR = 1,
  U_MEMORY_ALLOCATION_ERROR = 7,
};

#define U_SUCCESS(code) ((code) <= U_ZERO_ERROR)
#define U_FAILURE(code) ((code) > U_ZERO_ERROR)
#define U_FOLD_CASE_DEFAULT 0
#define USET_SIMPLE_CASE_INSENSITIVE 6
#define UCHAR_MAX_VALUE 0x10ffff
#define U_SHORT_PROPERTY_NAME 0
#define U_LONG_PROPERTY_NAME 1

#endif
