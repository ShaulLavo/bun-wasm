// bun-wasm's C interface to the Hermes VM (hermes::vm::Runtime), shaped like
// bunwasm-runtime's Engine trait (src/engine_hermes.rs). One runtime per
// process, single-threaded.
//
// Values cross as `bh_value` handles: indices into a slot table whose entries
// are GC roots (a custom roots function, as API/hermes_abi/hermes_vtable.cpp
// roots its ManagedValues). A handle owns one reference; bh_dup adds one and
// bh_release drops one. Functions that can throw return false and store the
// thrown value in *out.
//
// Built without C++ exceptions or RTTI, like the VM (hermes/build.sh).

#include "hermes/BCGen/HBC/HBC.h"
#include "hermes/Public/RuntimeConfig.h"
#include "hermes/Support/Buffer.h"
#include "hermes/VM/BigIntPrimitive.h"
#include "hermes/VM/Callable.h"
#include "hermes/VM/HostModel.h"
#include "hermes/VM/JSArray.h"
#include "hermes/VM/JSArrayBuffer.h"
#include "hermes/VM/JSError.h"
#include "hermes/VM/JSProxy.h"
#include "hermes/VM/JSTypedArray.h"
#include "hermes/VM/Operations.h"
#include "hermes/VM/Runtime.h"
#include "hermes/VM/StringPrimitive.h"
#include "hermes/VM/StringView.h"

#include <cstdint>
#include <cstring>
#include <deque>
#include <memory>
#include <string>
#include <vector>

namespace vm = hermes::vm;
namespace hbc = hermes::hbc;

typedef uint32_t bh_value;

// Implemented in Rust (src/engine_hermes.rs).
extern "C" bool bunhermes_host_call(
    uint32_t id,
    bh_value self,
    const bh_value *args,
    size_t count,
    bh_value *out);
extern "C" void bunhermes_host_drop(uint32_t id);
extern "C" bool bunhermes_host_interrupt();

namespace {

class Slots {
  // A deque keeps element addresses stable as it grows, so Handles made from
  // slots stay valid while new slots are added.
  std::deque<vm::PinnedHermesValue> values_;
  std::vector<uint32_t> refs_;
  std::vector<uint32_t> free_;

 public:
  Slots() {
    // Slot 0 is never handed out.
    values_.emplace_back(vm::HermesValue::encodeUndefinedValue());
    refs_.push_back(1);
  }

  bh_value add(vm::HermesValue hv) {
    if (!free_.empty()) {
      bh_value h = free_.back();
      free_.pop_back();
      values_[h] = hv;
      refs_[h] = 1;
      return h;
    }
    values_.emplace_back(hv);
    refs_.push_back(1);
    return (bh_value)(values_.size() - 1);
  }

  void dup(bh_value h) {
    refs_[h]++;
  }

  void release(bh_value h) {
    if (--refs_[h] != 0)
      return;
    values_[h] = vm::HermesValue::encodeUndefinedValue();
    free_.push_back(h);
  }

  vm::PinnedHermesValue &at(bh_value h) {
    return values_[h];
  }

  template <typename F>
  void forEach(F f) {
    for (auto &v : values_)
      f(v);
  }
};

struct State {
  std::shared_ptr<vm::Runtime> rt;
  Slots slots;
  hbc::CompileFlags flags;
  bool interruptible = false;
  bool interruptPending = false;
  uint32_t interruptCountdown = 0;
};

State *state;

vm::Runtime &rt() {
  return *state->rt;
}

bh_value add(vm::HermesValue hv) {
  return state->slots.add(hv);
}

vm::Handle<> handle(bh_value h) {
  return vm::Handle<>(&state->slots.at(h));
}

template <typename T>
vm::Handle<T> handleAs(bh_value h) {
  return vm::Handle<T>::vmcast(&state->slots.at(h));
}

vm::HermesValue value(bh_value h) {
  return state->slots.at(h);
}

// The pending exception, as a handle; clears it.
bool thrown(bh_value *out) {
  vm::HermesValue v = rt().getThrownValue();
  rt().clearThrownValue();
  *out = add(v.isEmpty() ? vm::HermesValue::encodeUndefinedValue() : v);
  return false;
}

bool result(vm::CallResult<vm::HermesValue> res, bh_value *out) {
  if (res == vm::ExecutionStatus::EXCEPTION)
    return thrown(out);
  *out = add(*res);
  return true;
}

bool result(vm::CallResult<vm::PseudoHandle<>> res, bh_value *out) {
  if (res == vm::ExecutionStatus::EXCEPTION)
    return thrown(out);
  *out = add(res->get());
  return true;
}

vm::CallResult<vm::Handle<vm::SymbolID>> symbol(const char *s, size_t len) {
  auto str = vm::StringPrimitive::createEfficient(
      rt(), llvh::makeArrayRef((const uint8_t *)s, len), true);
  if (str == vm::ExecutionStatus::EXCEPTION)
    return vm::ExecutionStatus::EXCEPTION;
  return vm::stringToSymbolID(
      rt(), vm::createPseudoHandle(vm::vmcast<vm::StringPrimitive>(*str)));
}

vm::CallResult<vm::HermesValue> hostCall(void *context, vm::Runtime &runtime) {
  vm::NativeArgs args = runtime.getCurrentFrame().getNativeArgs();
  llvh::SmallVector<bh_value, 8> handles;
  for (vm::HermesValue hv : args)
    handles.push_back(add(hv));
  bh_value self = add(args.getThisArg());
  bh_value out = 0;
  // Rust takes ownership of `self` and the argument handles.
  bool ok = bunhermes_host_call(
      (uint32_t)(uintptr_t)context,
      self,
      handles.data(),
      handles.size(),
      &out);
  vm::HermesValue ret = value(out);
  state->slots.release(out);
  if (!ok) {
    runtime.setThrownValue(ret);
    return vm::ExecutionStatus::EXCEPTION;
  }
  return ret;
}

void hostFinalize(void *context) {
  bunhermes_host_drop((uint32_t)(uintptr_t)context);
}

} // namespace

// Polled at every AsyncBreakCheck instruction (emitted when interruptible).
// The patch enables these Emscripten hooks for WASI (hermes/hermes-wasi.patch).
extern "C" bool test_wasm_host_timeout() {
  if (!state || !state->interruptible)
    return false;
  if (state->interruptPending)
    return true;
  if (state->interruptCountdown-- != 0)
    return false;
  state->interruptCountdown = 10000;
  state->interruptPending = bunhermes_host_interrupt();
  return state->interruptPending;
}

extern "C" bool test_and_clear_wasm_host_timeout() {
  bool pending = test_wasm_host_timeout();
  if (state)
    state->interruptPending = false;
  return pending;
}

extern "C" {

enum bh_kind {
  BH_UNDEFINED,
  BH_NULL,
  BH_BOOL,
  BH_NUMBER,
  BH_STRING,
  BH_SYMBOL,
  BH_BIGINT,
  BH_OBJECT,
  BH_FUNCTION,
  BH_ARRAY,
  BH_UINT8ARRAY,
  BH_ARRAYBUFFER,
};

void bh_init(uint32_t maxHeapMiB, bool interruptible) {
  auto gc = vm::GCConfig::Builder()
                .withMaxHeapSize((vm::gcheapsize_t)maxHeapMiB << 20)
                .build();
  auto config = vm::RuntimeConfig::Builder()
                    .withGCConfig(gc)
                    .withMicrotaskQueue(true)
                    .withEnableAsyncGenerators(true)
                    .withES6Proxy(true)
                    .build();
  state = new State();
  state->rt = vm::Runtime::create(config);
  state->rt->addCustomRootsFunction([](vm::GC *, vm::RootAcceptor &acceptor) {
    state->slots.forEach([&](vm::PinnedHermesValue &v) { acceptor.accept(v); });
  });
  state->flags.enableES6BlockScoping = true;
  state->flags.enableAsyncGenerators = true;
  state->flags.lazy = true;
  state->flags.emitAsyncBreakCheck = interruptible;
  state->interruptible = interruptible;
  state->interruptCountdown = 10000;
}

bh_value bh_dup(bh_value h) {
  state->slots.dup(h);
  return h;
}

void bh_release(bh_value h) {
  state->slots.release(h);
}

bh_value bh_undefined() {
  return add(vm::HermesValue::encodeUndefinedValue());
}

bh_value bh_null() {
  return add(vm::HermesValue::encodeNullValue());
}

bh_value bh_bool(bool b) {
  return add(vm::HermesValue::encodeBoolValue(b));
}

bh_value bh_number(double n) {
  return add(vm::HermesValue::encodeUntrustedNumberValue(n));
}

bh_value bh_string(const char *s, size_t len) {
  vm::GCScope scope(rt());
  auto str = vm::StringPrimitive::createEfficient(
      rt(), llvh::makeArrayRef((const uint8_t *)s, len), true);
  if (str == vm::ExecutionStatus::EXCEPTION) {
    rt().clearThrownValue();
    return bh_undefined();
  }
  return add(*str);
}

bh_value bh_bigint(int64_t n, bool isUnsigned) {
  vm::GCScope scope(rt());
  auto res = isUnsigned
      ? vm::BigIntPrimitive::fromUnsigned(rt(), (uint64_t)n)
      : vm::BigIntPrimitive::fromSigned(rt(), n);
  if (res == vm::ExecutionStatus::EXCEPTION) {
    rt().clearThrownValue();
    return bh_undefined();
  }
  return add(*res);
}

bh_value bh_object() {
  vm::GCScope scope(rt());
  return add(vm::JSObject::create(rt()).getHermesValue());
}

bh_value bh_array(uint32_t length) {
  vm::GCScope scope(rt());
  auto res = vm::JSArray::create(rt(), length, length);
  if (res == vm::ExecutionStatus::EXCEPTION) {
    rt().clearThrownValue();
    return bh_undefined();
  }
  return add(res->getHermesValue());
}

bh_value bh_uint8array(const uint8_t *bytes, size_t len) {
  vm::GCScope scope(rt());
  auto res = vm::Uint8Array::allocate(rt(), len);
  if (res == vm::ExecutionStatus::EXCEPTION) {
    rt().clearThrownValue();
    return bh_undefined();
  }
  vm::Handle<vm::JSTypedArrayBase> arr = *res;
  if (len)
    memcpy(arr->data(rt()), bytes, len);
  return add(arr.getHermesValue());
}

bh_value bh_global() {
  return add(rt().getGlobal().getHermesValue());
}

int bh_kind(bh_value h) {
  vm::HermesValue v = value(h);
  if (v.isUndefined() || v.isEmpty())
    return BH_UNDEFINED;
  if (v.isNull())
    return BH_NULL;
  if (v.isBool())
    return BH_BOOL;
  if (v.isNumber())
    return BH_NUMBER;
  if (v.isString())
    return BH_STRING;
  if (v.isSymbol())
    return BH_SYMBOL;
  if (v.isBigInt())
    return BH_BIGINT;
  if (vm::vmisa<vm::Callable>(v))
    return BH_FUNCTION;
  if (vm::vmisa<vm::JSArray>(v))
    return BH_ARRAY;
  if (vm::vmisa<vm::Uint8Array>(v))
    return BH_UINT8ARRAY;
  if (vm::vmisa<vm::JSArrayBuffer>(v))
    return BH_ARRAYBUFFER;
  return BH_OBJECT;
}

bool bh_get_bool(bh_value h) {
  return value(h).getBool();
}

double bh_get_number(bh_value h) {
  return value(h).getNumber();
}

// The string's characters: ASCII bytes when *ascii is set, else UTF-16 units.
// Strings are always flat in this Hermes; valid until the next VM allocation.
const void *bh_string_data(bh_value h, size_t *len, bool *ascii) {
  vm::StringView view =
      vm::StringPrimitive::createStringView(rt(), handleAs<vm::StringPrimitive>(h));
  *len = view.length();
  *ascii = view.isASCII();
  if (*ascii)
    return view.castToCharPtr();
  return view.castToChar16Ptr();
}

bool bh_get_bigint(bh_value h, int64_t *out) {
  auto *b = vm::vmcast<vm::BigIntPrimitive>(value(h));
  *out = (int64_t)b->truncateToSingleDigit();
  return b->isTruncationToSingleDigitLossless(true);
}

// A Uint8Array's or ArrayBuffer's bytes. Valid until the next VM allocation.
const uint8_t *bh_bytes(bh_value h, size_t *len) {
  vm::HermesValue v = value(h);
  if (auto *arr = vm::dyn_vmcast<vm::JSTypedArrayBase>(v)) {
    if (!arr->attached(rt())) {
      *len = 0;
      return nullptr;
    }
    *len = arr->getByteLength();
    return arr->data(rt());
  }
  auto *buf = vm::vmcast<vm::JSArrayBuffer>(v);
  *len = buf->size();
  return buf->attached() && *len ? buf->getDataBlock() : nullptr;
}

bool bh_get(bh_value obj, const char *key, size_t len, bh_value *out) {
  vm::GCScope scope(rt());
  if (!value(obj).isObject()) {
    (void)rt().raiseTypeError("Cannot read property of a primitive");
    return thrown(out);
  }
  auto sym = symbol(key, len);
  if (sym == vm::ExecutionStatus::EXCEPTION)
    return thrown(out);
  return result(
      vm::JSObject::getNamedOrIndexed(handleAs<vm::JSObject>(obj), rt(), **sym),
      out);
}

bool bh_set(bh_value obj, const char *key, size_t len, bh_value v, bh_value *out) {
  vm::GCScope scope(rt());
  if (!value(obj).isObject()) {
    (void)rt().raiseTypeError("Cannot set property of a primitive");
    return thrown(out);
  }
  auto sym = symbol(key, len);
  if (sym == vm::ExecutionStatus::EXCEPTION)
    return thrown(out);
  auto res = vm::JSObject::putNamedOrIndexed(
      handleAs<vm::JSObject>(obj),
      rt(),
      **sym,
      handle(v),
      vm::PropOpFlags().plusThrowOnError());
  if (res == vm::ExecutionStatus::EXCEPTION)
    return thrown(out);
  *out = 0;
  return true;
}

bool bh_get_index(bh_value obj, uint32_t index, bh_value *out) {
  vm::GCScope scope(rt());
  vm::PinnedHermesValue key = vm::HermesValue::encodeTrustedNumberValue(index);
  return result(
      vm::JSObject::getComputed_RJS(
          handleAs<vm::JSObject>(obj), rt(), vm::Handle<>(&key)),
      out);
}

bool bh_set_index(bh_value obj, uint32_t index, bh_value v, bh_value *out) {
  vm::GCScope scope(rt());
  vm::PinnedHermesValue key = vm::HermesValue::encodeTrustedNumberValue(index);
  auto res = vm::JSObject::putComputed_RJS(
      handleAs<vm::JSObject>(obj),
      rt(),
      vm::Handle<>(&key),
      handle(v),
      vm::PropOpFlags().plusThrowOnError());
  if (res == vm::ExecutionStatus::EXCEPTION)
    return thrown(out);
  *out = 0;
  return true;
}

bh_value bh_function(const char *name, size_t len, uint32_t id) {
  vm::GCScope scope(rt());
  auto sym = symbol(name, len);
  if (sym == vm::ExecutionStatus::EXCEPTION) {
    rt().clearThrownValue();
    return bh_undefined();
  }
  auto res = vm::FinalizableNativeFunction::createWithoutPrototype(
      rt(), (void *)(uintptr_t)id, hostCall, hostFinalize, **sym, 0);
  if (res == vm::ExecutionStatus::EXCEPTION) {
    rt().clearThrownValue();
    return bh_undefined();
  }
  return add(*res);
}

bool bh_call(
    bh_value f,
    bh_value self,
    const bh_value *args,
    size_t count,
    bh_value *out) {
  vm::GCScope scope(rt());
  if (!vm::vmisa<vm::Callable>(value(f))) {
    (void)rt().raiseTypeError("not a function");
    return thrown(out);
  }
  auto func = handleAs<vm::Callable>(f);
  vm::ScopedNativeCallFrame frame{
      rt(),
      (uint32_t)count,
      func.getHermesValue(),
      vm::HermesValue::encodeUndefinedValue(),
      value(self)};
  if (LLVM_UNLIKELY(frame.overflowed())) {
    (void)rt().raiseStackOverflow(vm::Runtime::StackOverflowKind::NativeStack);
    return thrown(out);
  }
  for (size_t i = 0; i < count; i++)
    frame->getArgRef(i) = value(args[i]);
  return result(vm::Callable::call(func, rt()), out);
}

bool bh_construct(bh_value f, const bh_value *args, size_t count, bh_value *out) {
  vm::GCScope scope(rt());
  if (!vm::vmisa<vm::Callable>(value(f))) {
    (void)rt().raiseTypeError("not a constructor");
    return thrown(out);
  }
  auto func = handleAs<vm::Callable>(f);
  auto self = vm::Callable::createThisForConstruct_RJS(func, rt(), func);
  if (self == vm::ExecutionStatus::EXCEPTION)
    return thrown(out);
  vm::PinnedHermesValue thisArg = self->get();
  vm::ScopedNativeCallFrame frame{
      rt(), (uint32_t)count, func.getHermesValue(), func.getHermesValue(), thisArg};
  if (LLVM_UNLIKELY(frame.overflowed())) {
    (void)rt().raiseStackOverflow(vm::Runtime::StackOverflowKind::NativeStack);
    return thrown(out);
  }
  for (size_t i = 0; i < count; i++)
    frame->getArgRef(i) = value(args[i]);
  auto res = vm::Callable::call(func, rt());
  if (res == vm::ExecutionStatus::EXCEPTION)
    return thrown(out);
  vm::HermesValue r = res->get();
  *out = add(r.isObject() ? r : (vm::HermesValue)thisArg);
  return true;
}

bool bh_eval(
    const char *source,
    size_t len,
    const char *url,
    size_t urlLen,
    bh_value *out) {
  vm::GCScope scope(rt());
  llvh::StringRef name(url, urlLen);
  auto provider = hbc::createBCProviderFromSrc(
      std::make_unique<hermes::StdStringBuffer>(std::string(source, len)),
      name,
      {},
      state->flags);
  if (!provider.first) {
    (void)rt().raiseSyntaxError(vm::TwineChar16(provider.second.c_str()));
    return thrown(out);
  }
  return result(
      rt().runBytecode(
          std::move(provider.first),
          vm::RuntimeModuleFlags{},
          name,
          vm::Runtime::makeNullHandle<vm::Environment>()),
      out);
}

bool bh_has_jobs() {
  return rt().hasPendingJobs();
}

bool bh_drain_jobs(bh_value *out) {
  *out = 0;
  if (rt().drainJobs() == vm::ExecutionStatus::EXCEPTION)
    return thrown(out);
  rt().clearKeptObjects();
  if (rt().cleanUpFinalizationCallbacks() == vm::ExecutionStatus::EXCEPTION)
    return thrown(out);
  return true;
}

bool bh_strict_equals(bh_value a, bh_value b) {
  return vm::strictEqualityTest(value(a), value(b));
}

bool bh_instance_of(bh_value v, bh_value ctor) {
  vm::GCScope scope(rt());
  auto res = vm::ordinaryHasInstance(rt(), handle(ctor), handle(v));
  if (res == vm::ExecutionStatus::EXCEPTION) {
    rt().clearThrownValue();
    return false;
  }
  return *res;
}

bool bh_is_proxy(bh_value v) {
  return vm::vmisa<vm::JSProxy>(value(v));
}

bh_value bh_proxy_target(bh_value v) {
  if (!bh_is_proxy(v))
    return bh_undefined();
  vm::GCScope scope(rt());
  auto *proxy = vm::vmcast<vm::JSObject>(value(v));
  return add(vm::JSProxy::getTarget(proxy, rt()).getHermesValue());
}

bool bh_is_error(bh_value v) {
  return vm::vmisa<vm::JSError>(value(v));
}

bool bh_is_detachable(bh_value v) {
  auto *buf = vm::dyn_vmcast<vm::JSArrayBuffer>(value(v));
  return buf && buf->attached();
}

void bh_detach(bh_value v) {
  vm::GCScope scope(rt());
  vm::JSArrayBuffer::detach(rt(), handleAs<vm::JSArrayBuffer>(v));
}

void bh_gc() {
  rt().collect("forced");
}

void bh_heap_info(double *used, double *size) {
  vm::GCBase::HeapInfo info;
  rt().getHeap().getHeapInfo(info);
  *used = (double)info.allocatedBytes;
  *size = (double)info.heapSize;
}

} // extern "C"
