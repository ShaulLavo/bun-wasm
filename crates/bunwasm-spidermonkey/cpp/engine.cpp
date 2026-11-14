#include "engine.h"

#include <cmath>
#include <cstring>
#include <new>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

#include "jsapi.h"
#include "jsfriendapi.h"
#include "js/Array.h"
#include "js/ArrayBuffer.h"
#include "js/BigInt.h"
#include "js/CallAndConstruct.h"
#include "js/CompilationAndEvaluation.h"
#include "js/Context.h"
#include "js/Conversions.h"
#include "js/Equality.h"
#include "js/Exception.h"
#include "js/GCAPI.h"
#include "js/GlobalObject.h"
#include "js/Initialization.h"
#include "js/MemoryCallbacks.h"
#include "js/Interrupt.h"
#include "js/Modules.h"
#include "js/Object.h"
#include "js/Promise.h"
#include "js/Realm.h"
#include "js/ScriptPrivate.h"
#include "js/SharedArrayBuffer.h"
#include "js/SavedFrameAPI.h"
#include "js/Symbol.h"
#include "js/SourceText.h"
#include "js/Stack.h"
#include "js/String.h"
#include "js/WeakMap.h"
#include "js/experimental/TypedData.h"
#include "js/friend/MicroTask.h"
#include "js/AllocPolicy.h"
#include "mozilla/Vector.h"

namespace {
struct Slot {
  JS::PersistentRootedValue root;
  uint32_t refs = 1;
  Slot(JSContext* cx, const JS::Value& value) : root(cx, value) {}
};

JSContext* context = nullptr;
JS::PersistentRootedObject* global = nullptr;
JS::PersistentRootedValue* asyncContext = nullptr;
JS::PersistentRootedValue* originalThen = nullptr;
JS::PersistentRootedId* thenId = nullptr;
JS::PersistentRootedId* constructorId = nullptr;
JS::PersistentRootedValue* objectKeys = nullptr;
JS::PersistentRootedValue* errorConstructors[4] = {};
std::vector<Slot*> slots;
std::vector<uint32_t> freeSlots;
struct ModuleEntry;
using EntryVector = mozilla::Vector<ModuleEntry*, 0, js::SystemAllocPolicy>;
struct ModuleEntry {
  std::string name;
  JS::PersistentRootedObject record;
  uint64_t generation;
  EntryVector imports, importers;
  bool importAcquired = false, untrackedImporter = false, retired = false;
  uint64_t mark = 0;
  ModuleEntry* nextWork = nullptr;
  ModuleEntry* nextRetired = nullptr;
  ModuleEntry(const std::string& name, JS::HandleObject module, uint64_t generation)
      : name(name), record(context, module), generation(generation) {}
};
std::unordered_map<std::string, ModuleEntry*> modules;
ModuleEntry* retiredHead = nullptr;
uint32_t activeSnapshots = 0;
uint64_t nextGeneration = 1, passEpoch = 0;
JS::PersistentRootedObject* externalBuffers = nullptr;
uintptr_t stackBase = 0;
bool interruptible = false;
bool terminating = false;
uint32_t checks = 0;
uint64_t pblEntries = 0;

#if defined(BUNSM_CONTROLS)
bsm_handle controlLoading = 0;
bsm_handle controlBridge = 0;
bsm_handle controlEvaluation = 0;
bsm_handle controlDerived = 0;
bool controlRequireEntered = false;
const char* controlOutcome = "not entered";
void (*controlObserver)(const char*) = nullptr;
std::string controlPhase;
std::unordered_map<std::string, uint32_t> controlUses;
std::string controlFaultSite;
uint32_t controlFaultNth = 0;
uint32_t controlFaultKind = 0;
std::string controlObserved;
JS::PersistentRootedObject* controlHeapRoot = nullptr;
JS::AutoDisableGenerationalGC* controlHeapGuard = nullptr;
std::vector<JS::GCReason> controlGcReasons;
struct ControlOom {
  uint64_t jobsEntered;
  bool inJob;
};
std::vector<ControlOom> controlOoms;
uint64_t controlJobsEntered = 0;
bool controlInJob = false;
uint32_t controlHeapParameters[3] = {};
JS::GCSliceCallback controlPreviousSlice = nullptr;
std::string controlHoldSite, controlHoldName;
struct ControlHold {
  std::string name;
  JS::PersistentRootedObject module, closure, promise;
  ControlHold(const std::string& name, JS::HandleObject module,
              JS::HandleObject closure, JS::HandleObject promise)
      : name(name), module(context, module), closure(context, closure), promise(context, promise) {}
};
std::vector<ControlHold*> controlHolds;

void control_reset_require() {
  bsm_release(controlLoading);
  bsm_release(controlBridge);
  bsm_release(controlEvaluation);
  bsm_release(controlDerived);
  controlLoading = controlBridge = controlEvaluation = controlDerived = 0;
  controlRequireEntered = false;
  controlOutcome = "not entered";
  controlPhase = "requireSetup";
  controlObserved.clear();
}

void control_phase(const char* phase) { controlPhase = phase; }

bool control_fault(const char* site) {
  std::string key = controlPhase + ":" + site;
  uint32_t use = ++controlUses[key];
  if (key != controlFaultSite || use != controlFaultNth) return false;
  if (controlFaultKind == 1) JS_ReportOutOfMemory(context);
  if (controlFaultKind == 3) terminating = true;
  return true;
}
void recovery_outcome(const char* outcome) { controlOutcome = outcome; }
void control_observe(const char* point) {
  controlObserved = point;
  if (controlObserver) controlObserver(point);
}
bool control_hold(const char*, JS::HandleObject);
#else
void control_reset_require() {}
void control_phase(const char*) {}
bool control_fault(const char*) { return false; }
void recovery_outcome(const char*) {}
void control_observe(const char*) {}
constexpr bool control_hold(const char*, JS::HandleObject) { return false; }
#endif

[[noreturn]] void fatal(const char* message) {
  bunsm_host_fatal(message, strlen(message));
}

void require(bool ok, const char* message) {
  if (!ok) fatal(message);
}

const JS::Value& value(bsm_handle handle) {
  require(handle && handle <= slots.size() && slots[handle - 1], "invalid SpiderMonkey handle");
  return slots[handle - 1]->root.get();
}

bsm_handle hold(const JS::Value& input) {
  auto* slot = new Slot(context, input);
  if (freeSlots.empty()) {
    slots.push_back(slot);
    freeSlots.reserve(slots.capacity());
    return static_cast<bsm_handle>(slots.size());
  }
  bsm_handle handle = freeSlots.back();
  freeSlots.pop_back();
  slots[handle - 1] = slot;
  return handle;
}

bsm_handle hold_object(JSObject* object) {
  require(object != nullptr, "SpiderMonkey object allocation failed");
  return hold(JS::ObjectValue(*object));
}

bool failure(bsm_handle* out) {
  *out = 0;
  if (!JS_IsExceptionPending(context)) return false;
  JS::RootedValue exception(context);
  require(JS_GetPendingException(context, &exception), "pending exception unavailable");
  JS_ClearPendingException(context);
  *out = hold(exception);

  return false;
}

bool result(bool ok, JS::HandleValue output, bsm_handle* out) {
  if (!ok) return failure(out);
  *out = hold(output);
  return true;
}

bool restore_exception(bsm_handle error) {
  if (error == 0) return false;
  JS::RootedValue thrown(context, value(error));
  JS_SetPendingException(context, thrown);
  bsm_release(error);
  return false;
}

JSObject* object(bsm_handle handle) {
  const auto& input = value(handle);
  return input.isObject() ? &input.toObject() : nullptr;
}

JSString* utf8(const char* bytes, size_t length) {
  return JS_NewStringCopyUTF8N(context, JS::UTF8Chars(bytes, length));
}

bool to_utf8(JS::HandleValue input, std::string* out) {
  JS::RootedString string(context, JS::ToString(context, input));
  if (!string) return false;
  size_t length = JS::GetDeflatedUTF8StringLength(JS_EnsureLinearString(context, string));
  JS::UniqueChars encoded = JS_EncodeStringToUTF8(context, string);
  if (!encoded) return false;
  out->assign(encoded.get(), length);
  return true;
}

bool property_id(const char* bytes, size_t length, JS::MutableHandleId out) {
  JS::RootedString name(context, utf8(bytes, length));
  return name && JS_StringToId(context, name, out);
}

void finish_native(JS::GCContext*, JSObject* holder) {
  auto id = JS::GetReservedSlot(holder, 0);
  if (id.isInt32()) bunsm_host_drop(id.toPrivateUint32());
}

const JSClassOps nativeOps = {
  nullptr, nullptr, nullptr, nullptr, nullptr, nullptr, finish_native,
  nullptr, nullptr, nullptr
};
const JSClass nativeClass = {"BunNative", JSCLASS_HAS_RESERVED_SLOTS(1) | JSCLASS_FOREGROUND_FINALIZE, &nativeOps, nullptr, nullptr, nullptr};
const JSClass frameClass = {"BunAsyncFrame", JSCLASS_HAS_RESERVED_SLOTS(1), nullptr, nullptr, nullptr, nullptr};
const JSClass globalClass = {"Bun", JSCLASS_GLOBAL_FLAGS, &JS::DefaultGlobalClassOps, nullptr, nullptr, nullptr};

JSObject* saved_frame_object(JSContext* cx, JS::HandleObject frame, JS::SavedFrameSelfHosted selfHosted) {
  JS::RootedString source(cx), name(cx);
  uint32_t line = 0;
  JS::TaggedColumnNumberOneOrigin column;
  if (JS::GetSavedFrameSource(cx, nullptr, frame, &source, selfHosted) != JS::SavedFrameResult::Ok ||
      JS::GetSavedFrameFunctionDisplayName(cx, nullptr, frame, &name, selfHosted) != JS::SavedFrameResult::Ok ||
      JS::GetSavedFrameLine(cx, nullptr, frame, &line, selfHosted) != JS::SavedFrameResult::Ok ||
      JS::GetSavedFrameColumn(cx, nullptr, frame, &column, selfHosted) != JS::SavedFrameResult::Ok) return nullptr;
  JS::RootedObject result(cx, JS_NewPlainObject(cx));
  if (!result) return nullptr;
  JS::RootedValue field(cx, name ? JS::StringValue(name) : JS::NullValue());
  if (!JS_DefineProperty(cx, result, "name", field, JSPROP_ENUMERATE)) return nullptr;
  field.setString(source);
  if (!JS_DefineProperty(cx, result, "file", field, JSPROP_ENUMERATE)) return nullptr;
  field.setNumber(line);
  if (!JS_DefineProperty(cx, result, "line", field, JSPROP_ENUMERATE)) return nullptr;
  field.setNumber(column.oneOriginValue());
  if (!JS_DefineProperty(cx, result, "column", field, JSPROP_ENUMERATE)) return nullptr;
  return result;
}

bool has_saved_frame(JSContext* cx, JS::HandleObject frame, JS::SavedFrameSelfHosted selfHosted) {
  uint32_t sourceId = 0;
  return JS::GetSavedFrameSourceId(cx, nullptr, frame, &sourceId, selfHosted) == JS::SavedFrameResult::Ok;
}

bool error_frames(JSContext* cx, unsigned argc, JS::Value* vp) {
  JS::CallArgs args = JS::CallArgsFromVp(argc, vp);
  args.rval().setUndefined();
  if (args.length() < 2 || !args[0].isObject() || !args[1].isString()) return true;
  JS::RootedObject error(cx, &args[0].toObject());
  JS::RootedObject frame(cx, JS::ExceptionStackOrNull(error));
  if (!frame) return true;
  JS::RootedString original(cx), observed(cx, args[1].toString());
  if (!JS::BuildStackString(cx, nullptr, frame, &original, 0, js::StackFormat::SpiderMonkey)) return false;
  int32_t order = 0;
  if (!JS_CompareStrings(cx, original, observed, &order)) return false;
  if (order != 0) return true;
  const bool skipSelfHosted = args.length() > 2 && args[2].isBoolean() && args[2].toBoolean();
  const auto selfHosted = skipSelfHosted ? JS::SavedFrameSelfHosted::Exclude : JS::SavedFrameSelfHosted::Include;
  JS::RootedObject frames(cx, JS::NewArrayObject(cx, 0));
  if (!frames) return false;
  for (uint32_t index = 0; frame; ++index) {
    if (skipSelfHosted && !has_saved_frame(cx, frame, selfHosted)) break;
    JS::RootedString cause(cx);
    if (JS::GetSavedFrameAsyncCause(cx, nullptr, frame, &cause) != JS::SavedFrameResult::Ok) return true;
    if (cause) break;
    JS::RootedObject item(cx, saved_frame_object(cx, frame, selfHosted));
    if (!item) return !JS_IsExceptionPending(cx);
    if (!JS_SetElement(cx, frames, index, item)) return false;
    JS::RootedObject parent(cx);
    if (JS::GetSavedFrameParent(cx, nullptr, frame, &parent, selfHosted) != JS::SavedFrameResult::Ok) return true;
    frame = parent;
  }
  args.rval().setObject(*frames);
  return true;
}

bool install_error_frames(JSContext* cx, JS::HandleObject target) {
  JS::RootedString key(cx, JS_NewStringCopyZ(cx, "bunwasm.internal.spidermonkey.errorFrames"));
  if (!key) return false;
  JS::RootedSymbol symbol(cx, JS::GetSymbolFor(cx, key));
  JS::RootedFunction reader(cx, JS_NewFunction(cx, error_frames, 2, 0, "errorFrames"));
  if (!symbol || !reader) return false;
  JS::RootedId id(cx, JS::PropertyKey::Symbol(symbol));
  JS::RootedValue function(cx, JS::ObjectValue(*JS_GetFunctionObject(reader)));
  return JS_DefinePropertyById(cx, target, id, function, JSPROP_READONLY | JSPROP_PERMANENT);
}

bool native_dispatch(JSContext* cx, unsigned argc, JS::Value* vp) {
  JS::CallArgs args = JS::CallArgsFromVp(argc, vp);
  JS::RootedObject holder(cx, &js::GetFunctionNativeReserved(&args.callee(), 0).toObject());
  uint32_t id = JS::GetReservedSlot(holder, 0).toPrivateUint32();
  std::vector<bsm_handle> argv;
  argv.reserve(argc);
  for (unsigned i = 0; i < argc; ++i) argv.push_back(hold(args[i]));
  bsm_handle self = hold(args.thisv());
  bsm_handle out = 0;
  bool ok = bunsm_host_call(id, self, argv.data(), argv.size(), &out);
  bsm_release(self);
  for (bsm_handle handle : argv) bsm_release(handle);
  if (!ok) return restore_exception(out);
  args.rval().set(value(out));
  bsm_release(out);
  return true;
}

class Queue final : public JS::JobQueue {
 public:
  bool getHostDefinedData(JSContext* cx, JS::MutableHandleObject incumbent,
                          JS::MutableHandleObject optional) const override {
    if (control_fault("host-defined")) return false;
    incumbent.set(global->get());
    JS::RootedObject frame(cx, JS_NewObject(cx, &frameClass));
    if (!frame) return false;
    JS::SetReservedSlot(frame, 0, asyncContext->get());
    optional.set(frame);
    return true;
  }

  bool getHostDefinedGlobal(JSContext*, JS::MutableHandleObject out) const override {
    out.set(global->get());
    return true;
  }

  void runJobs(JSContext*) override;
  bool isDrainingStopped() const override { return JS_IsExceptionPending(context) || terminating; }

 protected:
  class Saved final : public SavedJobQueue {
    JSContext* cx;
    js::UniquePtr<JS::SavedMicroTaskQueue> tasks;
   public:
    Saved(JSContext* cx, js::UniquePtr<JS::SavedMicroTaskQueue> tasks)
        : cx(cx), tasks(std::move(tasks)) {}
    ~Saved() override { JS::RestoreMicroTaskQueue(cx, std::move(tasks)); }
  };

  js::UniquePtr<SavedJobQueue> saveJobQueue(JSContext* cx) override {
    auto tasks = JS::SaveMicroTaskQueue(cx);
    if (!tasks) return nullptr;
    return js::MakeUnique<Saved>(cx, std::move(tasks));
  }
};
Queue* queue = nullptr;

bool run_task(JS::Handle<mozilla::Maybe<JS::MicroTask>> task) {
  require(task->isJS(), "unexpected embedder microtask");
  JS::RootedObject execution(context, task->asJS().executionGlobal());
  if (!execution) return true;
  JSAutoRealm realm(context, execution);
  JS::RootedObject incumbent(context);
  JS::RootedObject captured(context);
  if (!task->asJS().maybeGetHostDefinedData(&incumbent, &captured)) return false;
  JS::RootedValue previous(context, asyncContext->get());
  asyncContext->set(captured ? JS::GetReservedSlot(captured, 0) : JS::UndefinedValue());
#if defined(BUNSM_CONTROLS)
  ++controlJobsEntered;
  controlInJob = true;
#endif
  bool ok = JS::RunJSMicroTask(context, task);
#if defined(BUNSM_CONTROLS)
  controlInJob = false;
#endif
  asyncContext->set(previous);
  return ok;
}

void Queue::runJobs(JSContext* cx) {
  for (;;) {
    if (isDrainingStopped()) return;
    JS::Rooted<mozilla::Maybe<JS::MicroTask>> task(cx, JS::DequeueNextRegularMicroTask(cx));
    if (task.isNothing()) return;
    if (!run_task(task)) return;
  }
}

bool resolve(const char* specifier, size_t length, const std::string& referrer,
             std::string* out) {
  char* bytes = nullptr;
  size_t size = 0;
  bsm_handle exception = 0;
  if (!bunsm_host_resolve(specifier, length, referrer.data(), referrer.size(), &bytes, &size, &exception)) {
    return restore_exception(exception);
  }
  out->assign(bytes, size);
  bunsm_host_free(bytes);
  return true;
}

void free_retired() {
  while (retiredHead) {
    ModuleEntry* entry = retiredHead;
    retiredHead = entry->nextRetired;
    delete entry;
  }
}

struct SnapshotScope {
  SnapshotScope() { ++activeSnapshots; }
  ~SnapshotScope() { if (--activeSnapshots == 0) free_retired(); }
};

ModuleEntry* mapped_entry(JS::HandleObject module) {
  JS::RootedValue privateValue(context, JS::GetModulePrivate(module));
  std::string name;
  if (!to_utf8(privateValue, &name)) return nullptr;
  auto found = modules.find(name);
  if (found == modules.end() || found->second->record != module) return nullptr;
  return found->second;
}

#if defined(BUNSM_CONTROLS)
bool control_hold(const char* site, JS::HandleObject module) {
  if (controlHoldSite != site) return false;
  ModuleEntry* entry = mapped_entry(module);
  return entry && entry->name == controlHoldName;
}
#endif

void remove_edges(EntryVector& edges, ModuleEntry* removed) {
  size_t kept = 0;
  for (auto* edge : edges) {
    if (edge != removed) edges[kept++] = edge;
  }
  edges.shrinkBy(edges.length() - kept);
}

bool record_edge(const std::string& ref, JS::HandleValue referrer, ModuleEntry* target) {
  auto found = modules.find(ref);
  if (found == modules.end() || !referrer.isObject() ||
      found->second->record != &referrer.toObject()) {
    target->untrackedImporter = true;
    return true;
  }
  ModuleEntry* source = found->second;
  if (control_fault("edge-reserve") || !source->imports.reserve(source->imports.length() + 1) ||
      control_fault("edge-reserve") || !target->importers.reserve(target->importers.length() + 1)) {
    JS_ReportOutOfMemory(context);
    return false;
  }
  source->imports.infallibleAppend(target);
  target->importers.infallibleAppend(source);
  return true;
}

bool snapshot_add(ModuleEntry* entry, EntryVector& candidates) {
  auto info = JS::GetModuleEvaluationInfo(entry->record);
  if (info.state == JS::ModuleEvaluationState::Fulfilled) return true;
  if (info.state != JS::ModuleEvaluationState::Unevaluated) {
    recovery_outcome("pinned at a boundary");
    return false;
  }
  if (entry->mark == passEpoch) return true;
  entry->mark = passEpoch;
  if (!control_fault("snapshot-append") && candidates.append(entry)) return true;
  JS_ClearPendingException(context);
  recovery_outcome("pinned on snapshot OOM");
  return false;
}

bool snapshot(JS::HandleObject module, EntryVector& candidates) {
  ++passEpoch;
  ModuleEntry* root = mapped_entry(module);
  if (!root) {
    JS_ClearPendingException(context);
    recovery_outcome("pinned at a boundary");
    return false;
  }
  if (!snapshot_add(root, candidates)) return false;
  for (size_t i = 0; i < candidates.length(); ++i) {
    for (auto* target : candidates[i]->imports) {
      if (!snapshot_add(target, candidates)) return false;
    }
  }
  return true;
}

bool unheld(ModuleEntry* entry) {
  if (!entry->importAcquired && !entry->untrackedImporter) return true;
  recovery_outcome("pinned on acquisition");
  return false;
}

void enqueue_retirement(ModuleEntry* entry, ModuleEntry*& head, ModuleEntry*& tail) {
  if (entry->mark == passEpoch) return;
  entry->mark = passEpoch;
  entry->nextWork = nullptr;
  if (tail) tail->nextWork = entry;
  else head = entry;
  tail = entry;
}

bool classify_candidate(ModuleEntry* entry, ModuleEntry*& head, ModuleEntry*& tail) {
  if (entry->retired) {
    recovery_outcome("pinned at a boundary");
    return false;
  }
  auto info = JS::GetModuleEvaluationInfo(entry->record);
  if (info.state == JS::ModuleEvaluationState::Pending) {
    recovery_outcome("pinned on a pending candidate");
    return false;
  }
  if (info.state != JS::ModuleEvaluationState::Failed) return true;
  if (info.bodyEntered || !info.overRecursed) {
    recovery_outcome(info.bodyEntered ? "pinned on body entry" : "pinned on a non-overflow error");
    return false;
  }
  if (!unheld(entry)) return false;
  enqueue_retirement(entry, head, tail);
  return true;
}

bool close_importer(ModuleEntry* entry, ModuleEntry*& head, ModuleEntry*& tail) {
  auto info = JS::GetModuleEvaluationInfo(entry->record);
  if (info.state == JS::ModuleEvaluationState::Pending ||
      info.state == JS::ModuleEvaluationState::Fulfilled) {
    recovery_outcome("pinned on a pending importer");
    return false;
  }
  if (info.state == JS::ModuleEvaluationState::Failed) return true;
  if (!unheld(entry)) return false;
  enqueue_retirement(entry, head, tail);
  return true;
}

void retire_entry(ModuleEntry* entry) {
  modules.erase(modules.find(entry->name));
  for (auto* target : entry->imports) remove_edges(target->importers, entry);
  for (auto* importer : entry->importers) remove_edges(importer->imports, entry);
  entry->imports.clear();
  entry->importers.clear();
  entry->record.reset();
  entry->retired = true;
  entry->nextRetired = retiredHead;
  retiredHead = entry;
}

void rollback(const EntryVector& candidates) {
  ++passEpoch;
  ModuleEntry* head = nullptr;
  ModuleEntry* tail = nullptr;
  for (auto* entry : candidates) {
    if (!classify_candidate(entry, head, tail)) return;
  }
  if (!head) return;
  for (auto* entry = head; entry; entry = entry->nextWork) {
    for (auto* importer : entry->importers) {
      if (!close_importer(importer, head, tail)) return;
    }
  }
  for (auto* entry = head; entry; entry = entry->nextWork) retire_entry(entry);
  recovery_outcome("rolled back");
}

JSObject* compile_module(const std::string& name, const char* source, size_t length) {
  auto found = modules.find(name);
  if (found != modules.end()) return found->second->record;
  JS::SourceText<mozilla::Utf8Unit> text;
  if (!text.init(context, source, length, JS::SourceOwnership::Borrowed)) return nullptr;
  JS::CompileOptions options(context);
  options.setFileAndLine(name.c_str(), 1);
  JS::RootedObject module(context, JS::CompileModule(context, options, text));
  if (!module) return nullptr;
  JS::RootedString privateName(context, utf8(name.data(), name.size()));
  if (!privateName) return nullptr;
  JS::SetModulePrivate(module, JS::StringValue(privateName));
  ModuleEntry* entry = control_fault("entry-allocation") ? nullptr
      : new (std::nothrow) ModuleEntry(name, module, nextGeneration++);
  if (!entry) {
    JS_ReportOutOfMemory(context);
    return nullptr;
  }
  if (control_fault("map-insertion")) fatal("module map allocation failure");
  modules.emplace(name, entry);
  return module;
}

JSObject* load_module(const std::string& name) {
  auto found = modules.find(name);
  if (found != modules.end()) return found->second->record;
  char* source = nullptr;
  size_t length = 0;
  bsm_handle exception = 0;
  if (!bunsm_host_load(name.data(), name.size(), &source, &length, &exception)) {
    restore_exception(exception);
    return nullptr;
  }
  JSObject* module = compile_module(name, source, length);
  bunsm_host_free(source);
  return module;
}

bool finish_module_load(JSContext* cx, JS::HandleValue referrer, JS::HandleObject request,
                        JS::HandleValue payload, JS::HandleObject module);

bool module_load(JSContext* cx, JS::HandleValue referrer, JS::HandleObject request,
                 JS::HandleValue, JS::HandleValue payload, uint32_t, JS::ColumnNumberOneOrigin) {
  JS::RootedString specifier(cx, JS::GetModuleRequestSpecifier(cx, request));
  if (!specifier) return false;
  JS::RootedValue specifierValue(cx, JS::StringValue(specifier));
  JS::RootedValue privateValue(cx, JS::GetReferrerPrivate(referrer));
  std::string spec;
  std::string ref;
  if (!to_utf8(specifierValue, &spec)) return false;
  if (!privateValue.isUndefined() && !to_utf8(privateValue, &ref)) return false;
  std::string name;
  if (!resolve(spec.data(), spec.size(), ref, &name)) return false;
  if (control_fault("module-load")) return false;
  JS::RootedObject module(cx, load_module(name));
  if (!module) return false;
  JS::RootedObject payloadObject(cx, payload.isObject() ? &payload.toObject() : nullptr);
  bool dynamic = payloadObject && JS::IsPromiseObject(payloadObject);
  if (!dynamic && !record_edge(ref, referrer, modules.find(name)->second)) return false;
  return finish_module_load(cx, referrer, request, payload, module);
}

bool metadata(JSContext*, JS::HandleObject module, JS::HandleObject meta) {
  JS::RootedValue privateValue(context, JS::GetModulePrivate(module));
  std::string name;
  if (!to_utf8(privateValue, &name)) return false;
  bsm_handle handle = hold_object(meta);
  bsm_handle exception = 0;
  bool ok = bunsm_host_init_meta(name.data(), name.size(), handle, &exception);
  bsm_release(handle);
  return ok || restore_exception(exception);
}

JSObject* module_handler(JS::HandleObject target, JSNative callback, const char* name) {
  JS::RootedFunction function(context, js::NewFunctionWithReserved(context, callback, 1, 0, name));
  if (!function) return nullptr;
  JS::RootedObject handler(context, JS_GetFunctionObject(function));
  js::SetFunctionNativeReserved(handler, 0, JS::ObjectValue(*target));
  return handler;
}

void ensure_handled(JS::HandleObject promise) {
  require(JS::SetAnyPromiseIsHandled(context, promise), "SpiderMonkey promise ownership failed");
}

bool seal(JS::HandleObject promise) {
  constexpr unsigned attrs = JSPROP_READONLY | JSPROP_PERMANENT;
  if (control_fault("seal")) return false;
  if (!JS_DefinePropertyById(context, promise, *thenId, *originalThen, attrs)) return false;
  if (control_fault("seal")) return false;
  return JS_DefinePropertyById(context, promise, *constructorId, JS::UndefinedHandleValue, attrs);
}

JSObject* forward_internal(JS::HandleObject source) {
  JS::RootedObject forwarded(context, JS::CallOriginalPromiseThen(context, source, nullptr, nullptr));
  if (!forwarded) return nullptr;
  ensure_handled(forwarded);
  return seal(forwarded) ? forwarded.get() : nullptr;
}

bool module_rejected(JSContext* cx, unsigned argc, JS::Value* vp) {
  JS::CallArgs args = JS::CallArgsFromVp(argc, vp);
  JS::RootedObject promise(cx, &js::GetFunctionNativeReserved(&args.callee(), 0).toObject());
  JS::RootedValue reason(cx, args.get(0));
  args.rval().setUndefined();
  return JS::RejectPromise(cx, promise, reason);
}

bool dynamic_module_loaded(JSContext* cx, unsigned argc, JS::Value* vp) {
  JS::CallArgs args = JS::CallArgsFromVp(argc, vp);
  JS::RootedObject closure(cx, &js::GetFunctionNativeReserved(&args.callee(), 0).toObject());
  JS::RootedValue referrer(cx, JS::GetReservedSlot(closure, 0));
  JS::RootedObject request(cx, &JS::GetReservedSlot(closure, 1).toObject());
  JS::RootedValue payload(cx, JS::GetReservedSlot(closure, 2));
  JS::RootedObject module(cx, &JS::GetReservedSlot(closure, 3).toObject());
  args.rval().setUndefined();
#if defined(BUNSM_CONTROLS)
  if (control_hold("dynamic-loaded", module)) {
    if (!JS::ModuleLink(cx, module)) return false;
    controlHolds.push_back(new ControlHold(controlHoldName, module, closure, nullptr));
    return true;
  }
#endif
  return JS::FinishLoadingImportedModule(cx, referrer, request, payload, module, true);
}

bool finish_module_load(JSContext* cx, JS::HandleValue referrer, JS::HandleObject request,
                        JS::HandleValue payload, JS::HandleObject module) {
  JS::RootedObject promise(cx, payload.isObject() ? &payload.toObject() : nullptr);
  if (!promise || !JS::IsPromiseObject(promise)) {
    return JS::FinishLoadingImportedModule(cx, referrer, request, payload, module, true);
  }
  ModuleEntry* entry = mapped_entry(module);
  if (entry) entry->importAcquired = true;
  static const JSClass closureClass = {
      "BunDynamicImport", JSCLASS_HAS_RESERVED_SLOTS(4), nullptr, nullptr, nullptr, nullptr};
  JS::RootedObject closure(cx, JS_NewObjectWithGivenProto(cx, &closureClass, nullptr));
  if (!closure) return false;
  JS::SetReservedSlot(closure, 0, referrer);
  JS::SetReservedSlot(closure, 1, JS::ObjectValue(*request));
  JS::SetReservedSlot(closure, 2, payload);
  JS::SetReservedSlot(closure, 3, JS::ObjectValue(*module));
  JS::RootedObject fulfilled(cx, module_handler(closure, dynamic_module_loaded, "dynamicModuleLoaded"));
  JS::RootedObject rejected(cx, module_handler(promise, module_rejected, "dynamicModuleRejected"));
  if (!fulfilled || !rejected) return false;
  JS::RootedObject loading(cx);
  if (!JS::LoadRequestedModules(cx, module, JS::UndefinedHandleValue, &loading)) return false;
  return JS::AddPromiseReactions(cx, loading, fulfilled, rejected);
}

JSObject* continue_module_evaluate(JS::HandleObject module) {
  JS::RootedValue evaluation(context);
  if (!JS::ModuleEvaluate(context, module, &evaluation)) return nullptr;
  JS::RootedObject evaluated(context, &evaluation.toObject());
  ensure_handled(evaluated);
  control_phase("importForward");
  return forward_internal(evaluated);
}

bool module_evaluate_handler(JSContext* cx, unsigned argc, JS::Value* vp) {
  JS::CallArgs args = JS::CallArgsFromVp(argc, vp);
  control_phase("importEvaluate");
  JS::RootedObject module(cx, &js::GetFunctionNativeReserved(&args.callee(), 0).toObject());
  if (!JS::ModuleLink(cx, module)) return false;
#if defined(BUNSM_CONTROLS)
  if (control_hold("import-evaluate", module)) {
    JS::RootedObject parked(cx, JS::NewPromiseObject(cx, nullptr));
    if (!parked) return false;
    ensure_handled(parked);
    if (!seal(parked)) return false;
    controlHolds.push_back(new ControlHold(controlHoldName, module, nullptr, parked));
    args.rval().setObject(*parked);
    return true;
  }
#endif
  JS::RootedObject forwarded(cx, continue_module_evaluate(module));
  if (!forwarded) return false;
  control_phase("importAdoptE");
  args.rval().setObject(*forwarded);
  return true;
}

bool require_namespace(JSContext* cx, unsigned argc, JS::Value* vp) {
  JS::CallArgs args = JS::CallArgsFromVp(argc, vp);
  control_phase("requireNamespace");
  JS::RootedObject module(cx, &js::GetFunctionNativeReserved(&args.callee(), 0).toObject());
  JS::RootedObject ns(cx, JS::GetModuleNamespace(cx, module));
  if (!ns) return false;
  control_phase("derivedNamespace");
#if defined(BUNSM_CONTROLS)
  controlObserved = "require-namespace-returned";
#endif
  args.rval().setObject(*ns);
  return true;
}

bool namespace_handler(JSContext* cx, unsigned argc, JS::Value* vp) {
  JS::CallArgs args = JS::CallArgsFromVp(argc, vp);
  JS::RootedObject module(cx, &js::GetFunctionNativeReserved(&args.callee(), 0).toObject());
  JS::RootedObject ns(cx, JS::GetModuleNamespace(cx, module));
  if (!ns) return false;
  args.rval().setObject(*ns);
  return true;
}

bool require_loaded(JSContext* cx, unsigned argc, JS::Value* vp) {
  JS::CallArgs args = JS::CallArgsFromVp(argc, vp);
  control_phase("requireLoaded");
#if defined(BUNSM_CONTROLS)
  controlRequireEntered = true;
#endif
  recovery_outcome("no failure");
  JS::RootedObject module(cx, &js::GetFunctionNativeReserved(&args.callee(), 0).toObject());
  if (!JS::ModuleLink(cx, module)) return false;
  SnapshotScope scope;
  EntryVector candidates;
  bool freshRoot = js::GetFunctionNativeReserved(&args.callee(), 1).toBoolean();
  if (!freshRoot) recovery_outcome("pinned at a boundary");
  bool pinned = !freshRoot || !snapshot(module, candidates);
  control_observe("require-before-evaluate");
  JS::RootedValue evaluation(cx);
  if (!JS::ModuleEvaluate(cx, module, &evaluation)) {
    recovery_outcome("pinned because evaluation returned false");
    control_observe("require-after-evaluate");
    return false;
  }
  if (control_fault("silent-return") || control_fault("terminate-return")) return false;
  JS::RootedObject evaluated(cx, &evaluation.toObject());
  ensure_handled(evaluated);
#if defined(BUNSM_CONTROLS)
  controlEvaluation = hold_object(evaluated);
#endif
  JS::PromiseState state = JS::GetPromiseState(evaluated);
  if (state == JS::PromiseState::Rejected) {
    JS::RootedValue reason(cx, JS::GetPromiseResult(evaluated));
    if (!pinned) rollback(candidates);
    control_observe("require-after-evaluate");
    JS_SetPendingException(cx, reason, JS::ExceptionStackBehavior::DoNotCapture);
    return false;
  }
  control_observe("require-after-evaluate");
  if (state == JS::PromiseState::Fulfilled) {
    control_phase("requireNamespaceGet");
    if (control_fault("namespace-get")) return false;
    JS::RootedObject ns(cx, JS::GetModuleNamespace(cx, module));
    if (!ns) return false;
    control_phase("bridgeNamespace");
#if defined(BUNSM_CONTROLS)
    controlObserved = "require-loaded-returned";
#endif
    args.rval().setObject(*ns);
    return true;
  }
  control_phase("requireLoaded");
  if (control_fault("require-namespace-handler")) return false;
  JS::RootedObject handler(cx, module_handler(module, require_namespace, "requireNamespace"));
  if (!handler) return false;
  control_phase("requireDerived");
  JS::RootedObject derived(cx, JS::CallOriginalPromiseThen(cx, evaluated, handler, nullptr));
  if (!derived) return false;
  ensure_handled(derived);
  control_phase("requireLoaded");
#if defined(BUNSM_CONTROLS)
  controlDerived = hold_object(derived);
#endif
  if (!seal(derived)) return false;
  control_phase("bridgeAdoptD");
#if defined(BUNSM_CONTROLS)
  controlObserved = "require-loaded-returned";
#endif
  args.rval().setObject(*derived);
  return true;
}

bool evaluate_module(JS::HandleObject module, bsm_handle* out) {
  control_phase("importSetup");
  JS::RootedValue hostDefined(context, JS::ObjectValue(*module));
  JS::RootedObject loading(context);
  if (!JS::LoadRequestedModules(context, module, hostDefined, &loading)) return failure(out);
  JS::RootedObject handler(context, module_handler(module, module_evaluate_handler, "moduleEvaluate"));
  if (!handler) return failure(out);
  JS::RootedObject evaluation(context, JS::CallOriginalPromiseThen(context, loading, handler, nullptr));
  if (!evaluation) return failure(out);
  *out = hold_object(evaluation);
  return true;
}

bool namespace_promise(JS::HandleObject module, bsm_handle* out) {
  bsm_handle evaluation = 0;
  if (!evaluate_module(module, &evaluation)) { *out = evaluation; return false; }
  JS::RootedObject promise(context, object(evaluation));
  bsm_release(evaluation);
  JS::RootedObject handler(context, module_handler(module, namespace_handler, "moduleNamespace"));
  if (!handler) return failure(out);
  JS::RootedObject result(context, JS::CallOriginalPromiseThen(context, promise, handler, nullptr));
  if (!result) return failure(out);
  *out = hold_object(result);
  return true;
}

bool interrupt_callback(JSContext*) { return !terminating; }

void rejection(JSContext*, bool, JS::HandleObject promise,
               JS::PromiseRejectionHandlingState state, void*) {
  bsm_handle p = hold_object(promise);
  bsm_handle reason = hold(JS::GetPromiseResult(promise));
  bunsm_host_rejection(p, reason, state == JS::PromiseRejectionHandlingState::Handled);
  bsm_release(p);
  bsm_release(reason);
}

bool commonjs_body(const char* source, size_t length, int32_t line, std::string_view* body) {
  constexpr const char prefix[] = "(function __bunwasm_cjs__(exports, require, module, __filename, __dirname) {\n\n";
  constexpr const char suffix[] = "\n})";
  constexpr size_t header = sizeof(prefix) - 1;
  constexpr size_t footer = sizeof(suffix) - 1;
  if (line != -1 || length < header + footer || memcmp(source, prefix, header) ||
      memcmp(source + length - footer, suffix, footer)) return false;
  *body = std::string_view(source + header, length - header - footer);
  return true;
}

std::string commonjs_source(const char* source, size_t length, std::string_view body) {
  std::string adjusted(source, length);
  adjusted.erase(static_cast<size_t>(body.data() - source) - 1, 1);
  return adjusted;
}

bool compile_commonjs(const char* source, size_t length, const char* filename, int32_t line, bsm_handle* out) {
  std::string_view body;
  if (!commonjs_body(source, length, line, &body)) {
    constexpr const char message[] = "negative script lines require the CommonJS wrapper";
    *out = bsm_error(2, message, sizeof(message) - 1);
    return false;
  }
  // Remove one synthetic header newline: line zero plus one newline puts the unchanged body at line one.
  const std::string adjusted = commonjs_source(source, length, body);
  JS::SourceText<mozilla::Utf8Unit> text;
  if (!text.init(context, adjusted.data(), adjusted.size(), JS::SourceOwnership::Borrowed)) return failure(out);
  JS::CompileOptions options(context);
  options.setFileAndLine(filename, 0);
  JS::RootedScript script(context, JS::Compile(context, options, text));
  if (!script) return failure(out);
  JS::RootedString name(context, utf8(filename, strlen(filename)));
  if (!name) return failure(out);
  JS::SetScriptPrivate(script, JS::StringValue(name));
  JS::RootedValue output(context);
  return result(JS_ExecuteScript(context, script, &output), output, out);
}

bool is_external_buffer(JS::HandleObject obj) {
  JS::RootedValue key(context, JS::ObjectValue(*obj));
  JS::RootedValue marker(context);
  require(JS::GetWeakMapEntry(context, *externalBuffers, key, &marker), "external buffer identity inspection failed");
  return marker.isTrue();
}

}  // namespace

extern "C" void bunsm_vm_fatal(const char* text) { fatal(text); }
extern "C" void* bunsm_stack_base() { return reinterpret_cast<void*>(stackBase); }
// The library calls this at every portable-baseline interpreter entry and nowhere else.
extern "C" void bunsm_pbl_entry() { ++pblEntries; }
// Interrupt polls of both tiers (counted modulo 2^32), and portable-baseline entries.
extern "C" void bsm_tier_counts(uint32_t* polls, uint64_t* entries) {
  *polls = checks;
  *entries = pblEntries;
}
extern "C" void bunsm_poll_interrupt(JSContext* cx, uint8_t) {
  if (terminating || !interruptible || ++checks % 10000 != 0 || !bunsm_host_interrupt()) return;
  terminating = true;
  JS_RequestInterruptCallback(cx);
}

extern "C" void bsm_init(const bsm_config* config) {
  stackBase = config->stack_high;
  interruptible = config->interruptible != 0;
  require(JS_Init(), "JS_Init failed");
  context = JS_NewContext(config->max_gc_bytes);
  require(context != nullptr, "JS_NewContext failed");
  JS_SetGCParameter(context, JSGC_MAX_BYTES, config->max_gc_bytes);
  JS_SetGlobalJitCompilerOption(context, JSJITCOMPILER_PORTABLE_BASELINE_ENABLE, config->tier);
  JS_SetGlobalJitCompilerOption(context, JSJITCOMPILER_PORTABLE_BASELINE_WARMUP_THRESHOLD, 0);
  require(config->stack_high > config->stack_low + 65536, "invalid stack bounds");
  JS_SetNativeStackQuota(context, config->stack_high - config->stack_low - 65536);
#if defined(BUN_WASM_SHARED_GROUP)
  // The group futex parks a member safely, so its JS may block in Atomics.wait.
  JS_SetFutexCanWait(context);
#endif
  require(JS::InitSelfHostedCode(context), "self-hosted initialization failed");
  JS::RealmOptions options;
  options.creationOptions().setSharedMemoryAndAtomicsEnabled(true);
  JS::RootedObject object(context, JS_NewGlobalObject(context, &globalClass, nullptr, JS::FireOnNewGlobalHook, options));
  require(object != nullptr, "global creation failed");
  global = new JS::PersistentRootedObject(context, object);
  JSAutoRealm realm(context, object);
  require(JS::InitRealmStandardClasses(context), "standard classes failed");
  JS::RootedObject promisePrototype(context, JS::GetPromisePrototype(context));
  require(promisePrototype != nullptr, "Promise prototype missing");
  JS::RootedId capturedThenId(context);
  JS::RootedId capturedConstructorId(context);
  require(property_id("then", 4, &capturedThenId) &&
              property_id("constructor", 11, &capturedConstructorId),
          "Promise property atoms failed");
  JS::RootedValue capturedThen(context);
  require(JS_GetPropertyById(context, promisePrototype, capturedThenId, &capturedThen),
          "Promise.prototype.then missing");
  originalThen = new JS::PersistentRootedValue(context, capturedThen);
  thenId = new JS::PersistentRootedId(context, capturedThenId);
  constructorId = new JS::PersistentRootedId(context, capturedConstructorId);
  // Keep async allocation ancestry distinguishable from live frames for the runtime formatter.
  js::SetStackFormat(context, js::StackFormat::SpiderMonkey);
  require(install_error_frames(context, object), "saved-frame reader installation failed");
  asyncContext = new JS::PersistentRootedValue(context, JS::UndefinedValue());
  JS::RootedObject buffers(context, JS::NewWeakMapObject(context));
  require(buffers != nullptr, "external buffer identity map allocation failed");
  externalBuffers = new JS::PersistentRootedObject(context, buffers);
  const char* errorNames[] = {"Error", "TypeError", "RangeError", "SyntaxError"};
  for (size_t i = 0; i < 4; ++i) {
    JS::RootedValue constructor(context);
    require(JS_GetProperty(context, object, errorNames[i], &constructor), "error constructor missing");
    errorConstructors[i] = new JS::PersistentRootedValue(context, constructor);
  }
  queue = new Queue();
  JS::SetJobQueue(context, queue);
  JS::SetModuleLoadHook(JS_GetRuntime(context), module_load);
  JS::SetModuleMetadataHook(JS_GetRuntime(context), metadata);
  JS::SetPromiseRejectionTrackerCallback(context, rejection);
  JS::RootedValue objectConstructor(context);
  JS::RootedValue keys(context);
  require(JS_GetProperty(context, object, "Object", &objectConstructor), "Object constructor missing");
  JS::RootedObject constructor(context, &objectConstructor.toObject());
  require(JS_GetProperty(context, constructor, "keys", &keys), "Object.keys missing");
  objectKeys = new JS::PersistentRootedValue(context, keys);
  if (interruptible) require(JS_AddInterruptCallback(context, interrupt_callback), "interrupt callback failed");
}

extern "C" void bsm_shutdown(void) {
#if defined(BUNSM_CONTROLS)
  for (auto* held : controlHolds) delete held;
  controlHolds.clear();
  delete controlHeapRoot;
  delete controlHeapGuard;
  controlHeapRoot = nullptr;
  controlHeapGuard = nullptr;
#endif
  for (auto& entry : modules) delete entry.second;
  modules.clear();
  free_retired();
  delete externalBuffers;
  for (auto* root : errorConstructors) delete root;
  for (auto* slot : slots) delete slot;
  slots.clear();
  freeSlots.clear();
  delete objectKeys;
  delete constructorId;
  delete thenId;
  delete originalThen;
  delete asyncContext;
  delete global;
  JS_DestroyContext(context);
  delete queue;
  JS_ShutDown();
  context = nullptr;
}

extern "C" bsm_handle bsm_dup(bsm_handle handle) {
  value(handle);
  ++slots[handle - 1]->refs;
  return handle;
}
extern "C" void bsm_release(bsm_handle handle) {
  if (handle == 0) return;
  value(handle);
  Slot* slot = slots[handle - 1];
  if (--slot->refs != 0) return;
  delete slot;
  slots[handle - 1] = nullptr;
  freeSlots.push_back(handle);
}
extern "C" bsm_handle bsm_undefined() { return hold(JS::UndefinedValue()); }
extern "C" bsm_handle bsm_null() { return hold(JS::NullValue()); }
extern "C" bsm_handle bsm_bool(uint8_t input) { return hold(JS::BooleanValue(input != 0)); }
extern "C" bsm_handle bsm_number_value(double input) { return hold(JS::DoubleValue(input)); }
extern "C" bsm_handle bsm_global() { return hold_object(global->get()); }
extern "C" bsm_handle bsm_string(const char* bytes, size_t length) {
  JSAutoRealm realm(context, global->get());
  JS::RootedString string(context, utf8(bytes, length));
  require(string != nullptr, "string allocation failed");
  return hold(JS::StringValue(string));
}
extern "C" bsm_handle bsm_bigint(int64_t input, uint8_t isUnsigned) {
  JSAutoRealm realm(context, global->get());
  JS::RootedBigInt bigint(context, isUnsigned ? JS::NumberToBigInt(context, static_cast<uint64_t>(input)) : JS::NumberToBigInt(context, input));
  require(bigint != nullptr, "bigint allocation failed");
  return hold(JS::BigIntValue(bigint));
}
extern "C" uint32_t bsm_kind(bsm_handle handle) {
  JSAutoRealm realm(context, global->get());
  JS::RootedValue input(context, value(handle));
  if (input.isUndefined()) return 0;
  if (input.isNull()) return 1;
  if (input.isBoolean()) return 2;
  if (input.isNumber()) return 3;
  if (input.isString()) return 4;
  if (input.isBigInt()) return 5;
  if (!input.isObject()) return 11;
  JS::RootedObject obj(context, &input.toObject());
  bool array = false;
  require(JS::IsArrayObject(context, obj, &array), "array inspection failed");
  if (array) return 7;
  if (JS::IsCallable(obj)) return 8;
  if (JS::IsArrayBufferObject(obj)) return 9;
  if (JS_IsArrayBufferViewObject(obj)) return 10;
  return 6;
}
extern "C" double bsm_number(bsm_handle handle) { return value(handle).toNumber(); }
extern "C" uint8_t bsm_bool_value(bsm_handle handle) { return value(handle).toBoolean(); }
extern "C" int64_t bsm_bigint_value(bsm_handle handle) {
  return JS::ToBigInt64(value(handle).toBigInt());
}
extern "C" const char* bsm_string_data(bsm_handle handle, size_t* length) {
  JSAutoRealm realm(context, global->get());
  static std::string bytes;
  JS::RootedValue input(context, value(handle));
  require(to_utf8(input, &bytes), "string conversion failed");
  *length = bytes.size();
  return bytes.data();
}
extern "C" const uint8_t* bsm_bytes(bsm_handle handle, size_t* length) {
  JSAutoRealm realm(context, global->get());
  JS::RootedObject obj(context, object(handle));
  *length = 0;
  if (!obj) return nullptr;
  bool shared = false;
  JS::AutoCheckCannotGC nogc;
  if (JS::IsArrayBufferObject(obj)) {
    *length = JS::GetArrayBufferByteLength(obj);
    return JS::GetArrayBufferData(obj, &shared, nogc);
  }
  if (!JS_IsArrayBufferViewObject(obj)) return nullptr;
  *length = JS_GetArrayBufferViewByteLength(obj);
  return static_cast<uint8_t*>(JS_GetArrayBufferViewData(obj, &shared, nogc));
}
extern "C" bsm_handle bsm_uint8_array(const uint8_t* data, size_t length) {
  JSAutoRealm realm(context, global->get());
  JS::RootedObject array(context, JS_NewUint8Array(context, length));
  require(array != nullptr, "byte array allocation failed");
  JS::AutoCheckCannotGC nogc;
  bool shared = false;
  void* target = JS_GetArrayBufferViewData(array, &shared, nogc);
  if (length) memcpy(target, data, length);
  return hold_object(array);
}
extern "C" bsm_handle bsm_new_object() {
  JSAutoRealm realm(context, global->get());
  return hold_object(JS_NewPlainObject(context));
}
extern "C" bsm_handle bsm_new_array(size_t length) {
  JSAutoRealm realm(context, global->get());
  return hold_object(JS::NewArrayObject(context, length));
}
extern "C" bool bsm_get(bsm_handle handle, const char* key, size_t length, bsm_handle* out) {
  JSAutoRealm realm(context, global->get());
  JS::RootedValue input(context, value(handle));
  JS::RootedObject obj(context, JS::ToObject(context, input));
  if (!obj) return failure(out);
  JS::RootedId id(context);
  if (!property_id(key, length, &id)) return failure(out);
  JS::RootedValue output(context);
  bool ok = JS_GetPropertyById(context, obj, id, &output);
  return result(ok, output, out);
}
extern "C" bool bsm_set(bsm_handle handle, const char* key, size_t length, bsm_handle input, bsm_handle* out) {
  JSAutoRealm realm(context, global->get());
  JS::RootedValue target(context, value(handle));
  JS::RootedObject obj(context, JS::ToObject(context, target));
  if (!obj) return failure(out);
  JS::RootedId id(context);
  if (!property_id(key, length, &id)) return failure(out);
  JS::RootedValue item(context, value(input));
  *out = 0;
  return JS_SetPropertyById(context, obj, id, item) || failure(out);
}
extern "C" bsm_handle bsm_keys(bsm_handle handle) {
  JSAutoRealm realm(context, global->get());
  JS::RootedValue input(context, value(handle));
  JS::RootedValue output(context);
  JS::RootedValue function(context, objectKeys->get());
  bool ok = JS::Call(context, JS::UndefinedHandleValue, function, JS::HandleValueArray(input), &output);
  if (!ok) { JS_ClearPendingException(context); return hold_object(JS::NewArrayObject(context, 0)); }
  return hold(output);
}
extern "C" bool bsm_array_get(bsm_handle handle, uint32_t index, bsm_handle* out) {
  JSAutoRealm realm(context, global->get());
  JS::RootedObject obj(context, object(handle));
  JS::RootedValue output(context);
  return result(JS_GetElement(context, obj, index, &output), output, out);
}
extern "C" bool bsm_array_set(bsm_handle handle, uint32_t index, bsm_handle input) {
  JSAutoRealm realm(context, global->get());
  JS::RootedObject obj(context, object(handle));
  JS::RootedValue item(context, value(input));
  return JS_SetElement(context, obj, index, item);
}
extern "C" bsm_handle bsm_function(const char* name, size_t length, uint32_t nativeId) {
  JSAutoRealm realm(context, global->get());
  std::string functionName(name, length);
  JS::RootedObject holder(context, JS_NewObject(context, &nativeClass));
  require(holder != nullptr, "native holder allocation failed");
  JS::SetReservedSlot(holder, 0, JS::PrivateUint32Value(nativeId));
  JS::RootedFunction function(context, js::NewFunctionWithReserved(context, native_dispatch, 0, 0, functionName.c_str()));
  require(function != nullptr, "native function allocation failed");
  JS::RootedObject obj(context, JS_GetFunctionObject(function));
  js::SetFunctionNativeReserved(obj, 0, JS::ObjectValue(*holder));
  return hold_object(obj);
}
extern "C" bool bsm_call(bsm_handle function, bsm_handle self, const bsm_handle* argv, size_t argc, bsm_handle* out) {
  JSAutoRealm realm(context, global->get());
  JS::RootedValue callable(context, value(function));
  JS::RootedValue thisValue(context, value(self));
  JS::RootedValueVector args(context);
  if (!args.reserve(argc)) return failure(out);
  for (size_t i = 0; i < argc; ++i) args.infallibleAppend(value(argv[i]));
  JS::RootedValue output(context);
  return result(JS::Call(context, thisValue, callable, args, &output), output, out);
}
extern "C" bsm_handle bsm_error(uint32_t kind, const char* message, size_t length) {
  JSAutoRealm realm(context, global->get());
  require(kind < 4, "invalid error kind");
  JS::RootedValue constructor(context, errorConstructors[kind]->get());
  JS::RootedString text(context, utf8(message, length));
  require(text != nullptr, "error message allocation failed");
  JS::RootedValue argument(context, JS::StringValue(text));
  JS::RootedObject output(context);
  require(JS::Construct(context, constructor, JS::HandleValueArray(argument), &output), "error allocation failed");
  return hold_object(output);
}
extern "C" bool bsm_define_hidden(bsm_handle handle, const char* key, size_t length, bsm_handle input, bsm_handle* out) {
  JSAutoRealm realm(context, global->get());
  JS::RootedObject obj(context, object(handle));
  JS::RootedId id(context);
  if (!property_id(key, length, &id)) return failure(out);
  JS::RootedValue item(context, value(input));
  *out = 0;
  return JS_DefinePropertyById(context, obj, id, item, 0) || failure(out);
}
extern "C" bool bsm_eval_script(const char* source, size_t length, const char* filename, int32_t line, bsm_handle* out) {
  JSAutoRealm realm(context, global->get());
  JS::SourceText<mozilla::Utf8Unit> text;
  if (!text.init(context, source, length, JS::SourceOwnership::Borrowed)) return failure(out);
  JS::CompileOptions options(context);
  if (line < 0) return compile_commonjs(source, length, filename, line, out);
  options.setFileAndLine(filename, static_cast<uint32_t>(line));
  JS::RootedScript script(context, JS::Compile(context, options, text));
  if (!script) return failure(out);
  JS::RootedString name(context, utf8(filename, strlen(filename)));
  if (!name) return failure(out);
  JS::SetScriptPrivate(script, JS::StringValue(name));
  JS::RootedValue output(context);
  return result(JS_ExecuteScript(context, script, &output), output, out);
}
extern "C" bool bsm_eval_module(const char* source, size_t length, const char* name, size_t nameLength, bsm_handle* out) {
  JSAutoRealm realm(context, global->get());
  std::string filename(name, nameLength);
  JS::RootedObject module(context, compile_module(filename, source, length));
  if (module) modules.find(filename)->second->importAcquired = true;
  return module ? evaluate_module(module, out) : failure(out);
}
extern "C" bool bsm_import(const char* specifier, size_t length, bsm_handle* out) {
  JSAutoRealm realm(context, global->get());
  std::string name;
  if (!resolve(specifier, length, "", &name)) return failure(out);
  JS::RootedObject module(context, load_module(name));
  if (module) modules.find(name)->second->importAcquired = true;
  return module ? namespace_promise(module, out) : failure(out);
}
extern "C" bool bsm_require(const char* specifier, size_t length, bsm_handle* out) {
  JSAutoRealm realm(context, global->get());
  control_reset_require();
  std::string name;
  if (!resolve(specifier, length, "", &name)) return failure(out);
  uint64_t firstGeneration = nextGeneration;
  JS::RootedObject module(context, load_module(name));
  if (!module) return failure(out);
  JS::RootedValue hostDefined(context, JS::ObjectValue(*module));
  JS::RootedObject loading(context);
  if (control_fault("load-requested")) return failure(out);
  if (!JS::LoadRequestedModules(context, module, hostDefined, &loading)) return failure(out);
  ensure_handled(loading);
#if defined(BUNSM_CONTROLS)
  controlLoading = hold_object(loading);
#endif
  if (control_fault("require-handler")) return failure(out);
  JS::RootedObject handler(context, module_handler(module, require_loaded, "requireLoaded"));
  if (!handler) return failure(out);
  js::SetFunctionNativeReserved(handler, 1,
      JS::BooleanValue(modules.find(name)->second->generation >= firstGeneration));
  JS::RootedObject bridge(context, JS::CallOriginalPromiseThen(context, loading, handler, nullptr));
  if (!bridge) return failure(out);
  ensure_handled(bridge);
#if defined(BUNSM_CONTROLS)
  controlBridge = hold_object(bridge);
#endif
  *out = hold_object(bridge);
  return true;
}
#if defined(BUNSM_CONTROLS)
extern "C" const char* bsm_control_last_outcome() { return controlOutcome; }
extern "C" void bsm_control_observe(void (*observer)(const char*)) { controlObserver = observer; }
extern "C" void bsm_control_hold(const char* site, const char* name) {
  controlHoldSite = site ? site : "";
  controlHoldName = name ? name : "";
}
extern "C" bool bsm_control_held(const char* name) {
  for (auto* held : controlHolds) {
    if (held->name == name) return true;
  }
  return false;
}
bool resume_held(ControlHold* held) {
  JS::RootedObject module(context, held->module);
  if (held->closure) {
    JS::RootedObject closure(context, held->closure);
    JS::RootedValue referrer(context, JS::GetReservedSlot(closure, 0));
    JS::RootedObject request(context, &JS::GetReservedSlot(closure, 1).toObject());
    JS::RootedValue payload(context, JS::GetReservedSlot(closure, 2));
    return JS::FinishLoadingImportedModule(context, referrer, request, payload, module, true);
  }
  JS::RootedObject promise(context, held->promise);
  JS::RootedObject forwarded(context, continue_module_evaluate(module));
  if (forwarded) {
    JS::RootedValue output(context, JS::ObjectValue(*forwarded));
    return JS::ResolvePromise(context, promise, output);
  }
  JS::RootedValue reason(context);
  if (!JS_GetPendingException(context, &reason)) return false;
  JS_ClearPendingException(context);
  return JS::RejectPromise(context, promise, reason);
}
extern "C" bool bsm_control_resume(const char* name, bsm_handle* out) {
  JSAutoRealm realm(context, global->get());
  for (size_t i = 0; i < controlHolds.size(); ++i) {
    if (controlHolds[i]->name != name) continue;
    ControlHold* held = controlHolds[i];
    controlHolds.erase(controlHolds.begin() + i);
    bool ok = resume_held(held);
    delete held;
    *out = 0;
    return ok || failure(out);
  }
  return false;
}
extern "C" void bsm_control_module_info(const char* name, bsm_module_info* out) {
  *out = {};
  auto found = modules.find(name);
  ModuleEntry* entry = found == modules.end() ? nullptr : found->second;
  out->mapped = entry != nullptr;
  for (auto* retired = retiredHead; !entry && retired; retired = retired->nextRetired) {
    if (retired->name == name) entry = retired;
  }
  if (!entry) return;
  out->generation = entry->generation;
  out->retired = entry->retired;
  out->importAcquired = entry->importAcquired;
  out->untrackedImporter = entry->untrackedImporter;
  out->imports = entry->imports.length();
  out->importers = entry->importers.length();
  if (entry->retired) return;
  auto info = JS::GetModuleEvaluationInfo(entry->record);
  out->state = static_cast<uint32_t>(info.state);
  out->linked = JS::ModuleIsLinked(entry->record);
  out->bodyEntered = info.bodyEntered;
  out->overRecursed = info.overRecursed;
}
extern "C" bool bsm_control_edge(const char* source, const char* target) {
  auto a = modules.find(source), b = modules.find(target);
  if (a == modules.end() || b == modules.end()) return false;
  bool forward = false, reverse = false;
  for (auto* entry : a->second->imports) forward |= entry == b->second;
  for (auto* entry : b->second->importers) reverse |= entry == a->second;
  require(forward == reverse, "module edge is bidirectional");
  return forward;
}
extern "C" void bsm_control_retirement(size_t* count, uint32_t* active) {
  *active = activeSnapshots;
  *count = 0;
  for (auto* entry = retiredHead; entry; entry = entry->nextRetired) ++*count;
}
extern "C" void bsm_control_require_promises(bsm_handle* loading, bsm_handle* bridge,
                                              bsm_handle* evaluation, bsm_handle* derived) {
  *loading = controlLoading ? bsm_dup(controlLoading) : 0;
  *bridge = controlBridge ? bsm_dup(controlBridge) : 0;
  *evaluation = controlEvaluation ? bsm_dup(controlEvaluation) : 0;
  *derived = controlDerived ? bsm_dup(controlDerived) : 0;
}
extern "C" bool bsm_control_mark_handled(bsm_handle handle) {
  JSAutoRealm realm(context, global->get());
  JS::RootedObject promise(context, object(handle));
  return promise && JS::SetAnyPromiseIsHandled(context, promise);
}
extern "C" bool bsm_control_require_entered() { return controlRequireEntered; }
extern "C" bool bsm_control_module_linked(const char* name, size_t length) {
  auto found = modules.find(std::string(name, length));
  return found != modules.end() && JS::ModuleIsLinked(found->second->record);
}
extern "C" void bsm_control_fault(const char* site, uint32_t nth, uint32_t kind) {
  controlUses.clear();
  controlFaultSite = site ? site : "";
  controlFaultNth = nth;
  controlFaultKind = kind;
}
extern "C" int bsm_control_run_one_job() {
  JSAutoRealm realm(context, global->get());
  controlObserved.clear();
  JS::Rooted<mozilla::Maybe<JS::MicroTask>> task(context, JS::DequeueNextRegularMicroTask(context));
  if (task.isNothing()) return 0;
  return run_task(task) ? 1 : -1;
}
extern "C" bool bsm_control_run_until(const char* point) {
  for (uint32_t remaining = 10000; remaining; --remaining) {
    int ran = bsm_control_run_one_job();
    if (controlObserved == point) return true;
    if (ran <= 0) return false;
  }
  return false;
}
void control_gc_slice(JSContext*, JS::GCProgress progress, const JS::GCDescription& description) {
  if (progress == JS::GC_CYCLE_BEGIN) controlGcReasons.push_back(description.reason_);
}

void control_oom(JSContext*, void*) {
  controlOoms.push_back({controlJobsEntered, controlInJob});
}

bool control_heap_native(JSContext* cx, unsigned argc, JS::Value* vp) {
  JS::CallArgs args = JS::CallArgsFromVp(argc, vp);
  args.rval().setUndefined();
  return true;
}
extern "C" void bsm_control_fill_heap() {
  if (controlHeapGuard) return;
  JSAutoRealm realm(context, global->get());
  require(JS::CurrentGlobalOrNull(context) == global->get(), "heap fill needs the adapter realm");
  const JSGCParamKey keys[] = {JSGC_INCREMENTAL_GC_ENABLED, JSGC_COMPACTING_ENABLED,
                               JSGC_MIN_LAST_DITCH_GC_PERIOD};
  const uint32_t values[] = {0, 0, 1000000000};
  for (size_t i = 0; i < 3; ++i) {
    controlHeapParameters[i] = JS_GetGCParameter(context, keys[i]);
    JS_SetGCParameter(context, keys[i], values[i]);
  }
  controlGcReasons.clear();
  controlOoms.clear();
  controlGcReasons.reserve(16);
  controlOoms.reserve(16);
  controlPreviousSlice = JS::SetGCSliceCallback(context, control_gc_slice);
  JS::SetOutOfMemoryCallback(context, control_oom, nullptr);
  controlHeapGuard = new JS::AutoDisableGenerationalGC(context);
  JS_GC(context);
  JS::RootedObject previous(context);
  for (;;) {
    JS::RootedFunction function(context,
        js::NewFunctionWithReserved(context, control_heap_native, 1, 0, "heapFill"));
    if (!function) {
      JS_ClearPendingException(context);
      break;
    }
    JS::RootedObject next(context, JS_GetFunctionObject(function));
    if (previous) {
      js::SetFunctionNativeReserved(previous, 0, JS::ObjectValue(*next));
    } else {
      controlHeapRoot = new JS::PersistentRootedObject(context, next);
    }
    previous = next;
  }
  require(JS::CurrentGlobalOrNull(context) == global->get(), "heap fill left the adapter realm");
  size_t lastDitch = 0;
  for (auto reason : controlGcReasons) {
    if (reason == JS::GCReason::LAST_DITCH) ++lastDitch;
  }
  require(lastDitch == 1 && !controlOoms.empty(), "heap fill did not reach one real last-ditch OOM");
  controlGcReasons.clear();
  controlOoms.clear();
  controlJobsEntered = 0;
}
extern "C" void bsm_control_heap_report(bsm_heap_report* report) {
  report->gcCycles = controlGcReasons.size();
  report->lastDitchCycles = 0;
  for (auto reason : controlGcReasons) {
    if (reason == JS::GCReason::LAST_DITCH) ++report->lastDitchCycles;
  }
  report->ooms = controlOoms.size();
  report->firstOomJobsEntered = controlOoms.empty() ? 0 : controlOoms[0].jobsEntered;
  report->firstOomInJob = !controlOoms.empty() && controlOoms[0].inJob;
  report->jobsEntered = controlJobsEntered;
}
extern "C" void bsm_control_release_heap() {
  JSAutoRealm realm(context, global->get());
  delete controlHeapRoot;
  controlHeapRoot = nullptr;
  delete controlHeapGuard;
  controlHeapGuard = nullptr;
  const JSGCParamKey keys[] = {JSGC_INCREMENTAL_GC_ENABLED, JSGC_COMPACTING_ENABLED,
                               JSGC_MIN_LAST_DITCH_GC_PERIOD};
  for (size_t i = 0; i < 3; ++i) JS_SetGCParameter(context, keys[i], controlHeapParameters[i]);
  JS::SetGCSliceCallback(context, controlPreviousSlice);
  controlPreviousSlice = nullptr;
  JS::SetOutOfMemoryCallback(context, nullptr, nullptr);
  JS_GC(context);
}
#endif
extern "C" bool bsm_drain_jobs(bsm_handle* out) {
  JSAutoRealm realm(context, global->get());
  bool ran = JS::HasRegularMicroTasks(context);
  queue->runJobs(context);
  JS::ClearKeptObjects(context);
  *out = 0;
  if (JS_IsExceptionPending(context) || terminating) { failure(out); return ran; }
  return ran;
}
extern "C" bool bsm_terminated() { return terminating; }
extern "C" int bsm_promise_state(bsm_handle handle) {
  JSAutoRealm realm(context, global->get());
  JS::RootedObject obj(context, object(handle));
  if (!obj || !JS::IsPromiseObject(obj)) return -1;
  return static_cast<int>(JS::GetPromiseState(obj));
}
extern "C" bsm_handle bsm_promise_result(bsm_handle handle) {
  JSAutoRealm realm(context, global->get());
  JS::RootedObject obj(context, object(handle));
  if (!obj || !JS::IsPromiseObject(obj)) return bsm_dup(handle);
  if (JS::GetPromiseState(obj) == JS::PromiseState::Pending) return bsm_undefined();
  return hold(JS::GetPromiseResult(obj));
}
extern "C" bool bsm_promise_then(bsm_handle promise, bsm_handle fulfilled, bsm_handle rejected, bsm_handle* out) {
  JSAutoRealm realm(context, global->get());
  JS::RootedObject p(context, object(promise));
  if (!p) {
    constexpr const char message[] = "promise reaction requires a Promise";
    *out = bsm_error(1, message, sizeof(message) - 1);
    return false;
  }
  JS::RootedObject ok(context, object(fulfilled));
  JS::RootedObject err(context, object(rejected));
  if (ok && !JS::IsCallable(ok)) ok.set(nullptr);
  if (err && !JS::IsCallable(err)) err.set(nullptr);
  JS::RootedObject output(context, JS::CallOriginalPromiseThen(context, p, ok, err));
  if (!output) return failure(out);
  *out = hold_object(output);
  return true;
}
extern "C" bool bsm_same_value(bsm_handle a, bsm_handle b) {
  JSAutoRealm realm(context, global->get());
  JS::RootedValue left(context, value(a));
  JS::RootedValue right(context, value(b));
  bool equal = false;
  require(JS::SameValue(context, left, right, &equal), "value identity inspection failed");
  return equal;
}
extern "C" bsm_handle bsm_external_buffer(uint8_t* data, size_t length) {
  JSAutoRealm realm(context, global->get());
  JS::RootedObject obj(context, JS::NewArrayBufferWithUserOwnedContents(context, length, data));
  require(obj != nullptr, "external buffer allocation failed");
  require(JS::PinArrayBufferOrViewLength(obj, true), "external buffer pin failed");
  JS::RootedValue key(context, JS::ObjectValue(*obj));
  require(JS::SetWeakMapEntry(context, *externalBuffers, key, JS::TrueHandleValue), "external buffer identity allocation failed");
  return hold_object(obj);
}
extern "C" bool bsm_detach_external(bsm_handle handle) {
  JSAutoRealm realm(context, global->get());
  JS::RootedObject obj(context, object(handle));
  if (!obj) return false;
  if (!is_external_buffer(obj)) return false;
  if (JS::IsDetachedArrayBufferObject(obj)) return true;
  require(JS::PinArrayBufferOrViewLength(obj, false), "external buffer unpin failed");
  require(JS::DetachArrayBuffer(context, obj), "external buffer detach failed");
  return true;
}
#if defined(BUN_WASM_SHARED_GROUP)
// A real SharedArrayBuffer over a core-validated group region, without copying. It is never
// pinned or detached: growth publishes a longer view and every older prefix stays live.
extern "C" bool bsm_shared_region_buffer(uint8_t* data, size_t length, bsm_handle* out) {
  JSAutoRealm realm(context, global->get());
  JS::RootedObject obj(context, JS::NewSharedArrayBufferOverGroupRegion(context, data, length));
  if (!obj) return failure(out);
  *out = hold_object(obj);
  return true;
}
// The storage of a real SharedArrayBuffer, so the core can name its region. Null for any other value.
extern "C" uint8_t* bsm_shared_buffer_data(bsm_handle handle) {
  JSObject* obj = object(handle);
  if (!obj || !JS::IsSharedArrayBufferObject(obj)) return nullptr;
  bool shared = false;
  JS::AutoCheckCannotGC nogc;
  return JS::GetSharedArrayBufferData(obj, &shared, nogc);
}
#endif
extern "C" bool bsm_is_detachable_buffer(bsm_handle handle) {
  JSAutoRealm realm(context, global->get());
  JS::RootedObject obj(context, object(handle));
  if (!obj || !JS::IsArrayBufferObject(obj) || JS::IsDetachedArrayBufferObject(obj)) return false;
  if (is_external_buffer(obj)) return false;
  bool keyed = false;
  require(JS::HasDefinedArrayBufferDetachKey(context, obj, &keyed), "buffer detach key inspection failed");
  return !keyed;
}
extern "C" void bsm_detach_buffer(bsm_handle handle) {
  JSAutoRealm realm(context, global->get());
  if (!bsm_is_detachable_buffer(handle)) return;
  JS::RootedObject obj(context, object(handle));
  require(JS::DetachArrayBuffer(context, obj), "buffer detach failed");
}
extern "C" bool bsm_is_proxy(bsm_handle handle) {
  JSObject* obj = object(handle);
  return obj && js::IsScriptedProxy(obj);
}
extern "C" bsm_handle bsm_proxy_target(bsm_handle handle) {
  JSObject* obj = object(handle);
  if (!obj || !js::IsScriptedProxy(obj)) return bsm_undefined();
  JSObject* target = js::GetProxyTargetObject(obj);
  return target ? hold_object(target) : bsm_undefined();
}
extern "C" bool bsm_is_error(bsm_handle handle) {
  JSAutoRealm realm(context, global->get());
  JS::RootedObject obj(context, object(handle));
  if (!obj) return false;
  js::ESClass cls;
  require(JS::GetBuiltinClass(context, obj, &cls), "error class inspection failed");
  return cls == js::ESClass::Error;
}
extern "C" bsm_handle bsm_async_context() { return hold(asyncContext->get()); }
extern "C" void bsm_set_async_context(bsm_handle handle) { asyncContext->set(value(handle)); }
extern "C" void bsm_gc() { JSAutoRealm realm(context, global->get()); JS_GC(context); }
extern "C" void bsm_heap_info(double* used, double* total, double* external) {
  *used = JS_GetGCParameter(context, JSGC_BYTES);
  *total = JS_GetGCParameter(context, JSGC_TOTAL_CHUNKS) * static_cast<double>(js::gc::ChunkSize);
  *external = std::nan("");
}

#if defined(BUNSM_CONTROLS)
#include "../tests/engine-semantics.cpp"
#endif
