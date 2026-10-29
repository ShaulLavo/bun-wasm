#pragma once

#include <cstddef>
#include <cstdint>

struct BhMemoryTelemetry {
  uint64_t abi_version = 1;
  uint64_t byte_size = 64;
  uint64_t refresh_sequence = 0;
  uint64_t heap_used = UINT64_MAX;
  uint64_t heap_capacity = UINT64_MAX;
  uint64_t external = UINT64_MAX;
  uint64_t counters_valid = 0;
  uint64_t refresh_disabled = 0;
};

static_assert(sizeof(BhMemoryTelemetry) == 64);
static_assert(alignof(BhMemoryTelemetry) == 8);
static_assert(offsetof(BhMemoryTelemetry, refresh_disabled) == 56);

class BhMemoryTelemetryCache {
  BhMemoryTelemetry snapshot_;

 public:
  const BhMemoryTelemetry *cached() const { return &snapshot_; }
  void stop() { snapshot_.refresh_disabled = 1; }

  template <typename ReadHeapInfo>
  const BhMemoryTelemetry *refresh(bool ready, ReadHeapInfo read) {
    if (!ready || snapshot_.refresh_disabled)
      return cached();
    // An interrupted refresh stays disabled, preserving the last complete sample.
    stop();
    const auto info = read();
    snapshot_.heap_used = info.allocatedBytes;
    snapshot_.heap_capacity = info.heapSize;
    snapshot_.external = info.externalBytes;
    snapshot_.counters_valid = 1;
    snapshot_.refresh_sequence++;
    snapshot_.refresh_disabled = 0;
    return cached();
  }
};
