#include "WASIMemoryTelemetry.h"
#include <cassert>
#include <cstddef>
#include <cstdio>
#include <cstdlib>
#include <cstring>

static void checkLayout()
{
    static_assert(sizeof(BunjscMemoryTelemetry) == 192);
    static_assert(offsetof(BunjscMemoryTelemetry, heapUsed) == 24);
    static_assert(offsetof(BunjscMemoryTelemetry, failedAllocationBytes) == 160);
    static_assert(offsetof(BunjscMemoryTelemetry, failedAllocationSequence) == 176);
    static_assert(offsetof(BunjscMemoryTelemetry, allocationBudgetThisCycle) == 184);
    const auto& snapshot = *bunjsc_cached_memory_telemetry();
    assert(snapshot.abiVersion == 1);
    assert(snapshot.byteLength == sizeof(snapshot));
    assert(snapshot.heapUsed == bunjscUnknownMemory);
    assert(snapshot.arrayBufferBytes == bunjscUnknownMemory);
    assert(snapshot.failedAllocationCategory == 0);
}

static void checkSuccess()
{
    {
        JSC::WASIMemoryAllocationScope allocation(4096, JSC::WASIMemoryAllocationScope::TypedArray);
        const auto& pending = *bunjsc_cached_memory_telemetry();
        assert(pending.activeAllocationBytes == 4096);
        assert(pending.activeAllocationCategory == 1);
        assert(pending.failedAllocationCategory == 0);
        allocation.succeed();
    }
    const auto& complete = *bunjsc_cached_memory_telemetry();
    assert(complete.activeAllocationCategory == 0);
    assert(complete.activeAllocationBytes == bunjscUnknownMemory);
    assert(complete.failedAllocationCategory == 0);
}

extern const BunjscMemoryTelemetry* otherTranslationUnit();

static void checkWideRequest()
{
    constexpr uint64_t request = static_cast<uint64_t>(UINT32_MAX) * 8;
    {
        JSC::WASIMemoryAllocationScope allocation(request, JSC::WASIMemoryAllocationScope::TypedArray);
        assert(bunjsc_cached_memory_telemetry()->activeAllocationBytes == request);
    }
    assert(bunjsc_cached_memory_telemetry()->failedAllocationBytes == request);
}

static void checkOriginalFailure()
{
    {
        JSC::WASIMemoryAllocationScope allocation(16777216, JSC::WASIMemoryAllocationScope::TypedArray);
    }
    // OOM exception construction uses ordinary allocations, outside these scopes.
    void* exception = std::malloc(128);
    std::free(exception);
    const auto& failed = *bunjsc_cached_memory_telemetry();
    assert(failed.failedAllocationBytes == 16777216);
    assert(failed.failedAllocationCategory == 1);
    assert(failed.failedAllocationSequence == 1);
    assert(failed.allocationSequence == 1);
    assert(failed.heapTotal == bunjscUnknownMemory);
}

static void checkRepeatedFailure()
{
    checkOriginalFailure();
    {
        JSC::WASIMemoryAllocationScope allocation(32768, JSC::WASIMemoryAllocationScope::ArrayBuffer);
    }
    const auto& latest = *bunjsc_cached_memory_telemetry();
    assert(latest.failedAllocationBytes == 32768);
    assert(latest.failedAllocationCategory == 2);
    assert(latest.failedAllocationSequence == 2);
}

static void checkNestedFailure()
{
    {
        JSC::WASIMemoryAllocationScope allocation(8192, JSC::WASIMemoryAllocationScope::TypedArray);
        {
            JSC::WASIMemoryAllocationScope backing(64, JSC::WASIMemoryAllocationScope::ArrayBuffer);
        }
        assert(bunjsc_cached_memory_telemetry()->failedAllocationBytes == 8192);
    }
    assert(bunjsc_cached_memory_telemetry()->failedAllocationCategory == 1);
    assert(bunjsc_cached_memory_telemetry()->activeAllocationCategory == 0);
}

static void checkAbandonedAllocation()
{
    // A Wasm trap does not unwind the C++ scope. The cached readout still works.
    auto* allocation = new JSC::WASIMemoryAllocationScope(12345678, JSC::WASIMemoryAllocationScope::TypedArray);
    const auto* snapshot = bunjsc_cached_memory_telemetry();
    assert(snapshot->activeAllocationBytes == 12345678);
    assert(snapshot->activeAllocationCategory == 1);
    assert(snapshot->failedAllocationCategory == 0);
    delete allocation;
}

int main(int argc, char** argv)
{
    assert(argc == 2);
    checkLayout();
    assert(otherTranslationUnit() == bunjsc_cached_memory_telemetry());
    if (!std::strcmp(argv[1], "success"))
        checkSuccess();
    else if (!std::strcmp(argv[1], "failure"))
        checkOriginalFailure();
    else if (!std::strcmp(argv[1], "nested"))
        checkNestedFailure();
    else if (!std::strcmp(argv[1], "abandoned"))
        checkAbandonedAllocation();
    else if (!std::strcmp(argv[1], "wide"))
        checkWideRequest();
    else if (!std::strcmp(argv[1], "repeated"))
        checkRepeatedFailure();
    else
        return EXIT_FAILURE;
    std::puts(argv[1]);
}
