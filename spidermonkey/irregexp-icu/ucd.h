#ifndef BUNWASM_ICU_UCD_H
#define BUNWASM_ICU_UCD_H
#include <cstddef>
#include <cstdint>
extern "C" {
using BunRangeSink = void (*)(void *, uint32_t, uint32_t);
using BunStringSink = void (*)(void *, const uint16_t *, size_t);
struct BunCodePointRange {
  uint32_t first;
  uint32_t last;
};
bool bunsm_ucd_property_ranges(uint32_t property, const char *binary_name,
                               int32_t value, BunRangeSink range,
                               BunStringSink string, void *context);
uint32_t bunsm_ucd_simple_fold(uint32_t code_point);
bool bunsm_ucd_is_letter(uint32_t code_point);
void bunsm_ucd_close_over_scf(const BunCodePointRange *ranges, size_t count,
                              BunRangeSink sink, void *context);
bool bunsm_ucd_value_enum(uint32_t property, const char *name, int32_t *out);
}
#endif
