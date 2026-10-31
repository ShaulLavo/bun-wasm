#include "WASIMemoryTelemetry.h"
#include <cassert>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <new>

#define OS(feature) BUNJSC_TEST_WASI
#define DECLARE_THROW_SCOPE(vm) ThrowScope(vm)

static const char* scenario;
static unsigned contextCalls;
static unsigned cellCalls;
static unsigned finishCalls;
static unsigned scopeExits;
static constexpr size_t requestLength = 17;
static constexpr uint64_t requestBytes = requestLength * sizeof(uint64_t);

[[noreturn]] static void stopWithoutUnwinding()
{
    assert(scopeExits == 0);
    std::puts(scenario);
    std::exit(EXIT_SUCCESS);
}

static void checkCachedFailure(bool failed)
{
    const auto& snapshot = *bunjsc_cached_memory_telemetry();
    assert(snapshot.snapshotSequence == 0);
    assert(snapshot.heapUsed == bunjscUnknownMemory);
    assert(snapshot.failedAllocationSequence == (failed ? 1u : 0u));
    assert(snapshot.failedAllocationCategory == (failed ? 1u : 0u));
    assert(snapshot.failedAllocationBytes == (failed ? requestBytes : bunjscUnknownMemory));
}

static void checkActiveRequest()
{
    const auto& snapshot = *bunjsc_cached_memory_telemetry();
    assert(snapshot.allocationSequence == (OS(WASI) ? 1u : 0u));
    assert(snapshot.activeAllocationBytes == (OS(WASI) ? requestBytes : bunjscUnknownMemory));
    assert(snapshot.activeAllocationCategory == (OS(WASI) ? 1u : 0u));
}

namespace JSC {

struct VM { };
struct Structure { };
struct JSGlobalObject {
    VM instance;
    VM& vm() { return instance; }
};
struct ThrowScope {
    explicit ThrowScope(VM&) { }
    ~ThrowScope() { ++scopeExits; }
};
struct ConstructionContext {
    ConstructionContext(VM&, Structure*, size_t length, unsigned elementSize)
    {
        ++contextCalls;
        assert(length == requestLength);
        assert(elementSize == sizeof(uint64_t));
    }
    explicit operator bool() const { return std::strncmp(scenario, "nullable-", 9); }
};

static void throwOutOfMemoryError(JSGlobalObject*, const ThrowScope&)
{
    assert(contextCalls == 1);
    assert(cellCalls == 0);
    assert(finishCalls == 0);
    checkActiveRequest();
    checkCachedFailure(OS(WASI));
    if (!std::strcmp(scenario, "nullable-trap"))
        stopWithoutUnwinding();
}

enum NotNullTag { NotNull };

template<typename T> void* allocateCell(VM&)
{
    ++cellCalls;
    checkActiveRequest();
    checkCachedFailure(false);
    if (!std::strcmp(scenario, "cell-trap"))
        stopWithoutUnwinding();
    alignas(T) static unsigned char storage[sizeof(T)];
    return storage;
}

template<typename Adaptor> class JSGenericTypedArrayView {
public:
    JSGenericTypedArrayView(VM&, ConstructionContext&) { }
    static JSGenericTypedArrayView* create(JSGlobalObject*, Structure*, size_t);
    void finishCreation(VM&) { ++finishCalls; }
};

} // namespace JSC

void* operator new(size_t, JSC::NotNullTag, void* storage) { return storage; }

namespace JSC {
#include "TypedArrayCreate.h"

struct Adaptor { using Type = uint64_t; };

int main(int argc, char** argv)
{
    assert(argc == 2);
    scenario = argv[1];
    JSC::JSGlobalObject global;
    JSC::Structure structure;
    const auto* result = JSC::JSGenericTypedArrayView<Adaptor>::create(&global, &structure, requestLength);
    assert(contextCalls == 1);
    assert(scopeExits == 1);
    assert(bunjsc_cached_memory_telemetry()->activeAllocationCategory == 0);
    if (!std::strcmp(scenario, "success")) {
        assert(result);
        assert(cellCalls == 1);
        assert(finishCalls == 1);
        checkCachedFailure(false);
    } else {
        assert(!std::strcmp(scenario, "nullable-return"));
        assert(!result);
        assert(cellCalls == 0);
        assert(finishCalls == 0);
        checkCachedFailure(OS(WASI));
    }
    std::puts(scenario);
}
