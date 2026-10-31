// Executable controls for the WASI JSC allocation-boundary record and probe in the actual
// patched WebKit header. A fake heap, structure and core wrapper stand in for JSC and the core.
#include "WASIMemoryTelemetry.h"
#include <cassert>
#include <cerrno>
#include <cstdio>
#include <cstring>

namespace {

struct FakeStructure {
    const void* global;
    const void* globalObject() const { return global; }
};

struct FakeHeap {
    bool collected { true };
    unsigned reads { 0 };
    size_t capacity() { ++reads; return 4096; }
    size_t extraMemorySize() { return 1024; }
    size_t arrayBufferSize() { return 512; }
    uint64_t totalBytesAllocated() const { return 65536; }
    size_t bytesAllocatedThisCycle() const { return 2048; }
    size_t allocationBudgetThisCycle() { return 8192; }
    size_t maxHeapSize() const { return 32768; }
    bool lastCollectionScope() const { return collected; }
    size_t sizeAfterLastCollection() const { return 3000; }
    size_t ramSize() const { return 1073741824; }
};

// Mirrors crates/bunwasm-cli/memory-telemetry.c: success counts one allocation, null counts one
// failure and latches only the first failed request.
struct FakeCore {
    BunjscCoreAllocatorSample sample { 100, 200, 65536, 0, 10, 4, bunjscUnknownMemory, 0 };
    unsigned reads { 0 };
};
FakeCore core;
char storage[1];

bool sampleFakeCore(BunjscCoreAllocatorSample& sample)
{
    ++core.reads;
    sample = core.sample;
    return true;
}

bool unreadableCore(BunjscCoreAllocatorSample&)
{
    return false;
}

enum class Outcome { Success, Null, SuccessWithCoreFailure };

void* allocate(uint64_t bytes, Outcome outcome, int allocatorErrno)
{
    if (allocatorErrno)
        errno = allocatorErrno;
    if (outcome == Outcome::Null) {
        ++core.sample.failures;
        if (!core.sample.firstFailureCategory) {
            core.sample.firstFailureSize = bytes;
            core.sample.firstFailureCategory = 2;
        }
        return nullptr;
    }
    if (outcome == Outcome::SuccessWithCoreFailure)
        ++core.sample.failures;
    ++core.sample.allocations;
    return storage;
}

int vmA;
int vmB;
int globalA;
FakeStructure structureA { &globalA };
FakeHeap heap;

void* observe(const void* vm, uint64_t count, uint64_t size, bool zeroFill, Outcome outcome, int allocatorErrno = 0)
{
    JSC::WASIAllocationBoundaryProbe boundary(vm, &structureA, heap, count, size, count * size, zeroFill);
    void* memory = allocate(count * size, outcome, allocatorErrno);
    boundary.finish(memory);
    return memory;
}

const BunjscAllocationBoundary& record()
{
    return bunjscAllocationBoundary;
}

void armControl(BunjscCoreAllocatorSampler sampler = sampleFakeCore)
{
    assert(bunjsc_boundary_arm_control(&vmA, &globalA, sampler));
    assert(record().state == BunjscBoundaryState::ControlArmed);
}

void acknowledgeControl()
{
    armControl();
    void* control = observe(&vmA, bunjscBoundaryControlLength, 1, true, Outcome::Success);
    assert(bunjsc_boundary_acknowledge_control(control) == BunjscBoundaryState::SubjectArmed);
}

constexpr uint64_t allWords = bunjscBoundaryBeforeWords | bunjscBoundaryAfterCallWords | bunjscBoundaryHeapWords
    | bunjscBoundaryCoreBeforeWords | bunjscBoundaryCoreAfterWords;

void checkLayout()
{
    static_assert(sizeof(BunjscAllocationBoundary) == 1000);
    static_assert(offsetof(BunjscAllocationBoundary, last) == 88);
    static_assert(offsetof(BunjscAllocationBoundary, control) == 392);
    static_assert(offsetof(BunjscAllocationBoundary, subject) == 696);
    static_assert(offsetof(BunjscAllocationBoundarySlot, errnoAfterCall) == 88);
    static_assert(offsetof(BunjscAllocationBoundarySlot, heapBefore) == 104);
    static_assert(offsetof(BunjscAllocationBoundarySlot, coreBefore) == 176);
    static_assert(offsetof(BunjscAllocationBoundarySlot, coreAfter) == 240);
    static_assert(allWords == (uint64_t(1) << 38) - 1);
    assert(record().abiVersion == 1);
    assert(record().byteLength == 1000);
    assert(record().state == BunjscBoundaryState::Disarmed);
    assert(record().expectedVmAddress == bunjscUnknownMemory);
    assert(record().controlLength == 1001);
    assert(!record().control.recorded && !record().control.availability);
    assert(record().control.requestBytes == bunjscUnknownMemory);
}

// Disarmed: no getter, core read, errno write or record change, and the result passes through.
void checkDisarmed()
{
    errno = 1234;
    void* memory = observe(&vmA, 4096, 1, true, Outcome::Success);
    assert(memory == storage);
    assert(observe(&vmA, 4096, 1, true, Outcome::Null) == nullptr);
    assert(errno == 1234);
    assert(!heap.reads && !core.reads);
    assert(!record().armedAttempts && !record().coverageMisses && !record().last.recorded);
}

void checkControlSuccess()
{
    armControl();
    assert(record().coreSamplerBound == 1);
    assert(record().expectedVmAddress == reinterpret_cast<uintptr_t>(&vmA));
    errno = 7;
    void* control = observe(&vmA, bunjscBoundaryControlLength, 1, true, Outcome::Success);
    assert(control == storage);
    assert(errno == 7);
    assert(bunjsc_boundary_acknowledge_control(control) == BunjscBoundaryState::SubjectArmed);
    const auto& slot = record().control;
    assert(record().rejection == BunjscBoundaryRejection::None);
    assert(slot.recorded == 1 && slot.attempt == 1 && slot.availability == allWords);
    assert(slot.requestBytes == 1001 && slot.elementCount == 1001 && slot.elementSize == 1 && slot.zeroFill == 1);
    assert(slot.vmAddress == reinterpret_cast<uintptr_t>(&vmA));
    assert(slot.globalObjectAddress == reinterpret_cast<uintptr_t>(&globalA));
    assert(slot.errnoBefore == 7 && slot.errnoAfterCall == 7 && slot.resultNull == 0);
    assert(slot.coreAfter.failures == slot.coreBefore.failures);
    assert(slot.coreAfter.allocations == slot.coreBefore.allocations + 1);
    assert(slot.heapBefore.maxHeapSize == 32768 && slot.heapBefore.ramSize == 1073741824);
    assert(slot.heapBefore.sizeAfterLastCollection == 3000);
    assert(!record().subject.recorded && !record().subjectFailures);
}

void checkRejected(BunjscBoundaryRejection expected)
{
    assert(record().state == BunjscBoundaryState::Rejected);
    assert(record().rejection == expected);
    // A rejected control never arms the subject: a later null result is not latched.
    unsigned reads = core.reads;
    assert(observe(&vmA, 6000000, 4, false, Outcome::Null) == nullptr);
    assert(!record().subject.recorded && !record().subjectFailures && core.reads == reads);
}

void checkControlCoreFailure()
{
    armControl();
    void* control = observe(&vmA, bunjscBoundaryControlLength, 1, true, Outcome::SuccessWithCoreFailure);
    assert(bunjsc_boundary_acknowledge_control(control) == BunjscBoundaryState::Rejected);
    checkRejected(BunjscBoundaryRejection::CoreFailureCount);
}

void checkControlNull()
{
    armControl();
    void* control = observe(&vmA, bunjscBoundaryControlLength, 1, true, Outcome::Null);
    assert(bunjsc_boundary_acknowledge_control(control) == BunjscBoundaryState::Rejected);
    assert(record().control.resultNull == 1);
    checkRejected(BunjscBoundaryRejection::ControlFailed);
}

void checkControlNotObserved()
{
    armControl();
    assert(bunjsc_boundary_acknowledge_control(true) == BunjscBoundaryState::Rejected);
    checkRejected(BunjscBoundaryRejection::ControlNotObserved);
}

void checkControlRequest()
{
    armControl();
    void* control = observe(&vmA, bunjscBoundaryControlLength, 2, false, Outcome::Success);
    assert(bunjsc_boundary_acknowledge_control(control) == BunjscBoundaryState::Rejected);
    checkRejected(BunjscBoundaryRejection::ControlRequest);
}

void checkControlAttempts()
{
    armControl();
    observe(&vmA, 2048, 1, true, Outcome::Success);
    void* control = observe(&vmA, bunjscBoundaryControlLength, 1, true, Outcome::Success);
    assert(bunjsc_boundary_acknowledge_control(control) == BunjscBoundaryState::Rejected);
    assert(record().control.requestBytes == 2048);
    checkRejected(BunjscBoundaryRejection::ControlAttempts);
}

// Without a readable core record the core words stay unobserved and the control cannot pass.
void checkSamplerUnbound()
{
    armControl(nullptr);
    assert(record().coreSamplerBound == 0);
    void* control = observe(&vmA, bunjscBoundaryControlLength, 1, true, Outcome::Success);
    assert(bunjsc_boundary_acknowledge_control(control) == BunjscBoundaryState::Rejected);
    const auto& slot = record().control;
    assert(!(slot.availability & (bunjscBoundaryCoreBeforeWords | bunjscBoundaryCoreAfterWords)));
    assert(slot.coreBefore.failures == bunjscUnknownMemory && slot.coreAfter.allocations == bunjscUnknownMemory);
    checkRejected(BunjscBoundaryRejection::CoreUnavailable);
}

void checkSamplerUnreadable()
{
    armControl(unreadableCore);
    assert(record().coreSamplerBound == 1);
    void* control = observe(&vmA, bunjscBoundaryControlLength, 1, true, Outcome::Success);
    assert(bunjsc_boundary_acknowledge_control(control) == BunjscBoundaryState::Rejected);
    checkRejected(BunjscBoundaryRejection::CoreUnavailable);
}

// Another VM is counted, never recorded, and fails the control closed.
void checkCoverageMiss()
{
    armControl();
    observe(&vmB, 4096, 1, true, Outcome::Success);
    void* control = observe(&vmA, bunjscBoundaryControlLength, 1, true, Outcome::Success);
    assert(record().coverageMisses == 1 && record().armedAttempts == 1);
    assert(bunjsc_boundary_acknowledge_control(control) == BunjscBoundaryState::Rejected);
    checkRejected(BunjscBoundaryRejection::CoverageMiss);
}

void checkSubjectLatch()
{
    acknowledgeControl();
    observe(&vmA, 4096, 4, false, Outcome::Success);
    assert(!record().subject.recorded);
    errno = 3;
    assert(observe(&vmA, 25297737, 1, true, Outcome::Null, ENOMEM) == nullptr);
    assert(errno == ENOMEM);
    observe(&vmB, 30000000, 1, true, Outcome::Null);
    assert(observe(&vmA, 40000000, 1, false, Outcome::Null) == nullptr);
    const auto& subject = record().subject;
    assert(record().subjectFailures == 2 && record().coverageMisses == 1);
    assert(subject.recorded == 1 && subject.attempt == 3 && subject.availability == allWords);
    assert(subject.requestBytes == 25297737 && subject.zeroFill == 1 && subject.resultNull == 1);
    assert(subject.errnoBefore == 3 && subject.errnoAfterCall == ENOMEM);
    assert(subject.coreAfter.failures == subject.coreBefore.failures + 1);
    assert(subject.coreAfter.allocations == subject.coreBefore.allocations);
    assert(subject.coreBefore.firstFailureCategory == 0 && subject.coreAfter.firstFailureSize == 25297737);
    assert(record().last.requestBytes == 40000000 && record().last.attempt == 4);
    assert(record().control.requestBytes == 1001);
}

void checkRearmRefused()
{
    acknowledgeControl();
    assert(!bunjsc_boundary_arm_control(&vmB, &globalA, sampleFakeCore));
    assert(bunjsc_boundary_acknowledge_control(false) == BunjscBoundaryState::SubjectArmed);
    assert(record().expectedVmAddress == reinterpret_cast<uintptr_t>(&vmA));
}

void checkNoCollection()
{
    heap.collected = false;
    acknowledgeControl();
    const auto& slot = record().control;
    assert(slot.heapBefore.sizeAfterLastCollection == bunjscUnknownMemory);
    assert(slot.availability == (allWords & ~bunjscBoundarySizeAfterLastCollectionWord));
}

// A trap inside the allocator never reaches finish(): the before-values stay readable.
void checkTrapPending()
{
    acknowledgeControl();
    JSC::WASIAllocationBoundaryProbe boundary(&vmA, &structureA, heap, 25297737, 1, 25297737, true);
    const auto& last = record().last;
    assert(last.recorded == 1 && last.requestBytes == 25297737);
    assert(last.availability == (allWords & ~(bunjscBoundaryAfterCallWords | bunjscBoundaryCoreAfterWords)));
    assert(last.errnoAfterCall == bunjscUnknownMemory && last.resultNull == bunjscUnknownMemory);
    assert(!record().subject.recorded);
}

// Prints every word for the host reader's cross-language decode check.
void dump()
{
    checkSubjectLatch();
    const auto* words = reinterpret_cast<const uint64_t*>(&record());
    for (size_t index = 0; index < sizeof(BunjscAllocationBoundary) / sizeof(uint64_t); ++index)
        std::printf("%llu\n", static_cast<unsigned long long>(words[index]));
}

struct Scenario {
    const char* name;
    void (*run)();
};

const Scenario scenarios[] = {
    { "layout", checkLayout }, { "disarmed", checkDisarmed }, { "control-success", checkControlSuccess },
    { "control-core-failure", checkControlCoreFailure }, { "control-null", checkControlNull },
    { "control-not-observed", checkControlNotObserved }, { "control-request", checkControlRequest },
    { "control-attempts", checkControlAttempts }, { "sampler-unbound", checkSamplerUnbound },
    { "sampler-unreadable", checkSamplerUnreadable }, { "coverage-miss", checkCoverageMiss },
    { "subject-latch", checkSubjectLatch }, { "rearm-refused", checkRearmRefused },
    { "no-collection", checkNoCollection }, { "trap-pending", checkTrapPending },
};

} // namespace

int main(int argc, char** argv)
{
    if (argc != 2)
        return 2;
    if (!std::strcmp(argv[1], "dump")) {
        dump();
        return 0;
    }
    for (const auto& scenario : scenarios) {
        if (std::strcmp(argv[1], scenario.name))
            continue;
        scenario.run();
        std::puts(scenario.name);
        return 0;
    }
    return 2;
}
