#include "memory-telemetry.h"

#include <cassert>
#include <csetjmp>
#include <cstdio>
#include <cstdlib>
#include <new>

struct SyntheticHeapInfo {
  uint64_t allocatedBytes;
  uint64_t heapSize;
  uint64_t externalBytes;
};

static size_t allocations;
static std::jmp_buf interruptedRefresh;
static BhMemoryTelemetryCache interrupted;

void *operator new(size_t size) {
  allocations++;
  if (void *pointer = std::malloc(size))
    return pointer;
  std::abort();
}

void operator delete(void *pointer) noexcept { std::free(pointer); }
void operator delete(void *pointer, size_t) noexcept { std::free(pointer); }

int main() {
  static_assert(offsetof(BhMemoryTelemetry, abi_version) == 0);
  static_assert(offsetof(BhMemoryTelemetry, byte_size) == 8);
  static_assert(offsetof(BhMemoryTelemetry, refresh_sequence) == 16);
  static_assert(offsetof(BhMemoryTelemetry, heap_used) == 24);
  static_assert(offsetof(BhMemoryTelemetry, heap_capacity) == 32);
  static_assert(offsetof(BhMemoryTelemetry, external) == 40);
  static_assert(offsetof(BhMemoryTelemetry, counters_valid) == 48);
  BhMemoryTelemetryCache cache;
  const auto *snapshot = cache.cached();
  assert(snapshot->abi_version == 1 && snapshot->byte_size == 64);
  assert(snapshot->refresh_sequence == 0 && snapshot->counters_valid == 0);
  assert(snapshot->heap_used == UINT64_MAX);
  assert(snapshot->heap_capacity == UINT64_MAX && snapshot->external == UINT64_MAX);
  unsigned reads = 0;
  auto read = [&] {
    reads++;
    const auto *nested = cache.refresh(true, [] { std::abort(); return SyntheticHeapInfo{}; });
    assert(nested == snapshot && nested->refresh_disabled == 1);
    return SyntheticHeapInfo{UINT64_C(9007199254740993), 2097152, 1048576};
  };
  cache.refresh(false, read);
  assert(reads == 0 && snapshot->counters_valid == 0);
  cache.refresh(true, read);
  assert(reads == 1 && snapshot->refresh_sequence == 1);
  assert(snapshot->heap_used == UINT64_C(9007199254740993));
  assert(snapshot->heap_capacity == 2097152 && snapshot->external == 1048576);
  assert(snapshot->counters_valid == 1 && snapshot->refresh_disabled == 0);
  const auto before = allocations;
  for (unsigned i = 0; i < 1000; i++) {
    assert(cache.cached() == snapshot);
    assert(snapshot->heap_used == UINT64_C(9007199254740993));
    assert(snapshot->refresh_sequence == 1);
  }
  assert(allocations == before && reads == 1);
  cache.stop();
  cache.refresh(true, read);
  assert(reads == 1 && snapshot->refresh_sequence == 1 && snapshot->refresh_disabled == 1);
  BhMemoryTelemetryCache failedInit;
  failedInit.stop();
  failedInit.refresh(true, read);
  assert(reads == 1 && failedInit.cached()->heap_used == UINT64_MAX);
  interrupted.refresh(true, [] { return SyntheticHeapInfo{100, 200, 300}; });
  if (setjmp(interruptedRefresh) == 0) {
    interrupted.refresh(true, [] {
      std::longjmp(interruptedRefresh, 1);
      return SyntheticHeapInfo{};
    });
  }
  interrupted.refresh(true, [] { std::abort(); return SyntheticHeapInfo{}; });
  assert(interrupted.cached()->refresh_disabled == 1);
  assert(interrupted.cached()->refresh_sequence == 1);
  assert(interrupted.cached()->heap_used == 100 && interrupted.cached()->counters_valid == 1);
  puts("Hermes cache ABI: 64 bytes, 1000 allocation-free cached reads; synthetic inputs only");
}
