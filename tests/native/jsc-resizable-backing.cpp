#include "config.h"
#include "APICast.h"
#include "ArrayBuffer.h"
#include "JSArrayBuffer.h"
#include "JSArrayBufferView.h"
#include "JSArrayBufferViewInlines.h"
#include "JSContextRef.h"
#include "JSGlobalObject.h"
#include "JSLock.h"
#include "TypedArrayInlines.h"
#include "WASIResizableBufferTesting.h"
#include <wtf/StringPrintStream.h>
#include <cstdio>
#include <cstdlib>
#include <cstring>

using namespace JSC;

namespace JSC {
WASIResizableBufferTestHooks* wasiResizableBufferTestHooks { nullptr };
}

static void require(bool condition, const char* message)
{
    if (condition)
        return;
    std::fprintf(stderr, "native backing control failed: %s\n", message);
    std::abort();
}

static String accounting()
{
    StringPrintStream stream;
    BufferMemoryManager::singleton().dump(stream);
    return stream.toString();
}

static JSValueRef evaluate(JSGlobalContextRef context, const char* source, bool failure = false)
{
    auto text = JSStringCreateWithUTF8CString(source);
    JSValueRef exception = nullptr;
    auto result = JSEvaluateScript(context, text, nullptr, nullptr, 1, &exception);
    JSStringRelease(text);
    require(failure == !!exception, failure ? "missing expected exception" : "unexpected JS exception");
    if (failure) {
        auto* global = toJS(context);
        auto value = toJS(global, exception);
        auto* object = value.getObject();
        require(object, "exception must be an object");
        auto name = JSStringCreateWithUTF8CString("name");
        auto errorName = JSObjectGetProperty(context, toRef(object), name, nullptr);
        JSStringRelease(name);
        auto expected = JSStringCreateWithUTF8CString("RangeError");
        auto actual = JSValueToStringCopy(context, errorName, nullptr);
        require(JSStringIsEqual(expected, actual), "allocation refusal must be RangeError");
        JSStringRelease(expected);
        JSStringRelease(actual);
    }
    return result;
}

static void zeroRange(const uint8_t* data, size_t size)
{
    for (size_t index = 0; index < size; ++index) {
        if (data[index])
            require(false, "range must be zero before notification");
    }
}

struct Observation {
    ArrayBuffer* buffer { nullptr };
    BufferMemoryHandle* handle { nullptr };
    ArrayBufferView* nativeView { nullptr };
    JSArrayBufferView* views[4] { };
    void* oldData { nullptr };
    size_t oldLength { 0 };
    size_t oldCapacity { 0 };
    size_t requestedLength { 0 };
    unsigned publications { 0 };
    unsigned syncCollections { 0 };
    unsigned asyncCollections { 0 };
};

static Observation observation;

static void inspect(bool published)
{
    auto& state = observation;
    require(state.buffer && state.handle, "live owner at observation boundary");
    require(!state.buffer->isDetached(), "owner stays attached until publication completes");
    require(state.buffer->data() == state.handle->memory(), "contents and handle pointer agree");
    require(state.handle->size() == state.handle->mappedCapacity(), "capacity fields agree");
    require(state.buffer->byteLength() == (published ? state.requestedLength : state.oldLength), "logical length is published atomically");
    require(state.buffer->gcSizeEstimateInBytes() == sizeof(ArrayBuffer) + state.handle->size(), "GC counts retained capacity");
    require(wasiResizableBufferTestHooks->chargedBytes == state.handle->size(), "physical charge matches retained capacity");
    for (auto* view : state.views)
        require(view->vector() == static_cast<uint8_t*>(state.buffer->data()) + view->byteOffsetRaw(), "all JS vectors refreshed");
    require(state.nativeView->data() == static_cast<uint8_t*>(state.buffer->data()) + 4, "native wrapper reloads base");
    if (!published) {
        require(state.buffer->data() == state.oldData && state.handle->size() == state.oldCapacity, "failed attempt preserves pointer and capacity");
        return;
    }
    require(state.buffer->data() != state.oldData, "test allocator forced real movement");
    require(static_cast<uint8_t*>(state.buffer->data())[4] == 0x42, "movement preserves existing bytes");
    zeroRange(static_cast<uint8_t*>(state.buffer->data()) + state.oldLength, state.requestedLength - state.oldLength);
}

static void didPublish(ArrayBuffer& buffer, BufferMemoryHandle& handle)
{
    require(&buffer == observation.buffer && &handle == observation.handle, "same owner and handle during publication");
    ++observation.publications;
    inspect(true);
}

static void willCollect(bool synchronous)
{
    if (synchronous)
        ++observation.syncCollections;
    else
        ++observation.asyncCollections;
    inspect(observation.publications);
}

static void beforeResize(size_t requested)
{
    observation.oldData = observation.buffer->data();
    observation.oldLength = observation.buffer->byteLength();
    observation.oldCapacity = observation.handle->size();
    observation.requestedLength = requested;
    observation.publications = 0;
    observation.syncCollections = 0;
    observation.asyncCollections = 0;
}

static void rejectedResize(JSGlobalContextRef context, WASIResizableBufferTestHooks& hooks, bool charge)
{
    beforeResize(4194305);
    auto before = accounting();
    auto rollbacks = hooks.rollbacks;
    if (charge)
        hooks.refuseCharges = 2;
    else
        hooks.refuseReallocations = 2;
    evaluate(context, "rab.resize(4194305)", true);
    inspect(false);
    require(accounting() == before, "refusal returns physical accounting to baseline");
    require(observation.syncCollections == 1 && !observation.asyncCollections && !observation.publications, "refusal reclaims once before retry");
    require(hooks.rollbacks == rollbacks + (charge ? 0 : 2), "only charged realloc refusals roll back");
}

static void liveControls(JSGlobalContextRef context, WASIResizableBufferTestHooks& hooks)
{
    auto* global = toJS(context);
    JSLockHolder lock(global);
    evaluate(context, "globalThis.rab = new ArrayBuffer(16,{maxByteLength:1073741824});new Uint8Array(rab)[4]=0x42;globalThis.views=[new Uint8Array(rab,4),new Uint16Array(rab,4,4),new DataView(rab,4,8),new DataView(rab,4)];");
    auto* jsBuffer = dynamicDowncast<JSArrayBuffer>(toJS(global, evaluate(context, "rab")));
    require(jsBuffer, "real JS ArrayBuffer");
    observation.buffer = jsBuffer->impl();
    observation.handle = hooks.lastCreated;
    auto native = Uint8Array::create(RefPtr { observation.buffer }, 4, 8);
    observation.nativeView = native.ptr();
    auto array = JSValueToObject(context, evaluate(context, "views"), nullptr);
    for (unsigned index = 0; index < 4; ++index) {
        auto value = JSObjectGetPropertyAtIndex(context, array, index, nullptr);
        observation.views[index] = dynamicDowncast<JSArrayBufferView>(toJS(global, value));
        require(observation.views[index], "real JS typed-array or DataView");
    }
    require(hooks.initialRequestBytes == PageCount::pageSize, "logical maximum is not reserved eagerly");
    hooks.forceMove = true;
    hooks.forcePressure = true;
    hooks.didPublish = didPublish;
    hooks.willCollect = willCollect;
    beforeResize(3145731);
    evaluate(context, "rab.resize(3145731)");
    require(observation.publications == 1 && observation.asyncCollections == 1, "pressure follows complete moved publication");
    auto retained = hooks.chargedBytes;
    hooks.didPublish = nullptr;
    evaluate(context, "new Uint8Array(rab).fill(0x77,16);rab.resize(6)");
    require(!native->byteLength(), "fixed native view becomes OOB");
    zeroRange(static_cast<uint8_t*>(observation.buffer->data()) + 6, 3145731 - 6);
    evaluate(context, "rab.resize(16)");
    require(native->byteLength() == 8 && native->data()[0] == 0x42 && !native->data()[2], "native OOB recovery preserves offset and zeroing");
    require(hooks.chargedBytes == retained, "logical regrowth is not charged twice");
    hooks.didPublish = didPublish;
    rejectedResize(context, hooks, true);
    rejectedResize(context, hooks, false);
    beforeResize(4194305);
    hooks.refuseReallocations = 1;
    evaluate(context, "rab.resize(4194305)");
    require(observation.syncCollections == 1 && observation.asyncCollections == 1 && observation.publications == 1, "refusal retry publishes before pressure");
    beforeResize(5242881);
    hooks.refuseReallocations = 2;
    auto before = accounting();
    evaluate(context, "rab.transfer(5242881)", true);
    inspect(false);
    require(accounting() == before && !hooks.finalFrees, "failed transfer preserves owner and charge");
    beforeResize(5242881);
    evaluate(context, "globalThis.destination = rab.transfer(5242881)");
    require(observation.publications == 1 && observation.asyncCollections == 1, "transfer grows before detach");
    require(observation.buffer->isDetached() && native->isDetached(), "successful transfer detaches original aliases");
    for (auto* view : observation.views)
        require(!view->hasVector(), "successful transfer clears every original JS vector");
    hooks.didPublish = nullptr;
    hooks.willCollect = nullptr;
    evaluate(context, "if(destination.maxByteLength!==1073741824||new Uint8Array(destination)[4]!==0x42)throw Error('transfer');globalThis.fixed=destination.transferToFixedLength(32);");
    require(hooks.finalFrees == 1 && !hooks.chargedBytes, "fixed transfer frees malloc handle once");
}

static void allocationControls(JSGlobalContextRef context, WASIResizableBufferTestHooks& hooks)
{
    JSLockHolder lock(toJS(context));
    auto before = accounting();
    hooks.refuseAllocations = 2;
    require(!ArrayBuffer::tryCreate(16, 1, 1073741824), "initial allocator refusal is fallible");
    require(hooks.rollbacks == 2 && !hooks.chargedBytes && accounting() == before, "initial refusal releases every charge");
    auto attempts = hooks.chargeAttempts;
    require(!ArrayBuffer::tryCreate(MAX_ARRAY_BUFFER_SIZE, 1, MAX_ARRAY_BUFFER_SIZE), "rounded unsupported initial capacity is rejected");
    require(hooks.chargeAttempts == attempts, "rounding rejection precedes charging");
    auto* global = toJS(context);
    require(!ArrayBuffer::tryCreateShared(global->vm(), 0, 1, 0), "GSAB zero maximum stays unavailable");
    require(!ArrayBuffer::tryCreateShared(global->vm(), 16, 1, 32), "GSAB positive maximum stays unavailable");
    require(hooks.chargeAttempts == attempts, "shared allocation never enters malloc branch");
    auto fixed = ArrayBuffer::tryCreate(16, 1);
    require(!!fixed, "fixed backing is available");
    fixed->makeShared();
    require(fixed->isShared(), "fixed shared backing stays available");
}

static void repeatedOwnership(JSGlobalContextRef context, WASIResizableBufferTestHooks& hooks)
{
    auto* global = toJS(context);
    JSLockHolder lock(global);
    auto before = accounting();
    auto frees = hooks.finalFrees;
    for (unsigned index = 0; index < 32; ++index) {
        {
            auto source = ArrayBuffer::tryCreate(16, 1, 262144);
            require(!!source, "repeat initial allocation");
            require(!!source->resize(global->vm(), 131073), "repeat grow");
            ArrayBufferContents contents;
            require(source->transferTo(global->vm(), contents), "repeat transfer");
            auto destination = ArrayBuffer::create(WTF::move(contents));
            require(!!destination->resize(global->vm(), 8), "repeat shrink");
            destination->detach(global->vm());
        }
        require(!hooks.chargedBytes && accounting() == before, "repeat lifetime returns charge exactly");
    }
    require(hooks.finalFrees == frees + 32, "one final free for every repeated lifetime");
}

int main()
{
    auto context = JSGlobalContextCreate(nullptr);
    auto baseline = accounting();
    WASIResizableBufferTestHooks hooks;
    wasiResizableBufferTestHooks = &hooks;
    allocationControls(context, hooks);
    liveControls(context, hooks);
    repeatedOwnership(context, hooks);
    // Destroying a VM aborts in AtomStringImpl::remove on WASI JSC even with no resizable buffer,
    // and the guest never destroys its VM, so the control keeps the context alive. Every malloc
    // backing above already reached its single final free.
    require(!hooks.chargedBytes && accounting() == baseline, "controls leave no malloc backing charge");
    wasiResizableBufferTestHooks = nullptr;
    std::printf("moves=%u rollbacks=%u frees=%u\n", hooks.moves, hooks.rollbacks, hooks.finalFrees);
    std::puts("Deterministic native backing controls passed");
    return 0;
}
