#include "js/AllocationRecording.h"
#include "js/StructuredClone.h"
#include "js/UbiNode.h"

namespace JS::ubi {
struct FrameKindOffline {};
template <>
class ConcreteStackFrame<FrameKindOffline> final : public BaseStackFrame {
  explicit ConcreteStackFrame(FrameKindOffline* value) : BaseStackFrame(value) {}
 public:
  static void construct(void* storage, FrameKindOffline* value) {
    new (storage) ConcreteStackFrame(value);
  }
  StackFrame parent() const override { return StackFrame(); }
  uint32_t line() const override { return 1; }
  JS::TaggedColumnNumberOneOrigin column() const override { return JS::TaggedColumnNumberOneOrigin::fromRaw(14); }
  AtomOrTwoByteChars source() const override { return static_cast<const char16_t*>(u"/offline-kind.ts"); }
  uint32_t sourceId() const override { return 0; }
  AtomOrTwoByteChars functionDisplayName() const override { return static_cast<JSAtom*>(nullptr); }
  bool isSystem() const override { return false; }
  bool isSelfHosted(JSContext*) const override { return false; }
  bool constructSavedFrameStack(JSContext* cx, MutableHandleObject out) const override {
    StackFrame frame(static_cast<FrameKindOffline*>(ptr));
    return ConstructSavedFrameStackSlow(cx, frame, out);
  }
  void trace(JSTracer*) override {}
};
}  // namespace JS::ubi

namespace {
using FrameKind = JS::SavedFrameKind;

FrameKind frame_kind(JS::HandleObject frame, JS::SavedFrameSelfHosted selfHosted = includeSelfHosted) {
  FrameKind kind = FrameKind::Unknown;
  check(JS::GetSavedFrameKind(context, nullptr, frame, &kind, selfHosted) == JS::SavedFrameResult::Ok,
        "accessible frame kind");
  return kind;
}

bool capture_kind(JSContext* cx, unsigned argc, JS::Value* vp) {
  JS::CallArgs args = JS::CallArgsFromVp(argc, vp);
  JS::RootedObject frame(cx);
  if (!JS::CaptureCurrentStack(cx, &frame, JS::StackCapture(JS::MaxFrames(1)))) return false;
  if (args.length() && args[0].isBoolean() && args[0].toBoolean()) {
    Value nested(script("(()=>{ globalThis.kindReentered = captureKind(); })()", "/kind-reentry.ts"));
  }
  args.rval().setObject(*frame);
  return true;
}

void equal_kind_identity(JS::HandleObject first, JS::HandleObject second) {
  same_position(first, second);
  JS::RootedString sourceA(context), sourceB(context), nameA(context), nameB(context), causeA(context), causeB(context);
  JS::RootedObject parentA(context), parentB(context);
  check(JS::GetSavedFrameSource(context, nullptr, first, &sourceA) == JS::SavedFrameResult::Ok &&
        JS::GetSavedFrameSource(context, nullptr, second, &sourceB) == JS::SavedFrameResult::Ok && sourceA == sourceB,
        "same source atom");
  check(JS::GetSavedFrameFunctionDisplayName(context, nullptr, first, &nameA) == JS::SavedFrameResult::Ok &&
        JS::GetSavedFrameFunctionDisplayName(context, nullptr, second, &nameB) == JS::SavedFrameResult::Ok &&
        !nameA && !nameB, "both display names really null");
  check(JS::GetSavedFrameAsyncCause(context, nullptr, first, &causeA) == JS::SavedFrameResult::Ok &&
        JS::GetSavedFrameAsyncCause(context, nullptr, second, &causeB) == JS::SavedFrameResult::Ok && !causeA && !causeB,
        "same null async cause");
  check(JS::GetSavedFrameParent(context, nullptr, first, &parentA) == JS::SavedFrameResult::Ok &&
        JS::GetSavedFrameParent(context, nullptr, second, &parentB) == JS::SavedFrameResult::Ok && !parentA && !parentB,
        "one-frame captures have no script parent or native callback frame");
  check(read_frame(first).kind == filenameKind && read_frame(second).kind == filenameKind, "same source kind");
  JS::RootedValue thrown(context, JS::Int32Value(1));
  JS::ExceptionStack stackA(context, thrown, first), stackB(context, thrown, second);
  JS::ErrorReportBuilder reportA(context), reportB(context);
  check(reportA.init(context, stackA, JS::ErrorReportBuilder::NoSideEffects) &&
        reportB.init(context, stackB, JS::ErrorReportBuilder::NoSideEffects) &&
        !reportA.report()->isMuted && !reportB.report()->isMuted, "same unmuted errors");
}

void frame_kind_collision(bool programFirst) {
  const char* label = programFirst ? "/kind-program-first.ts" : "/kind-function-first.ts";
  const char* program = "             captureKind()";
  const char* function = "(function(){ captureKind()})()";
  Value first(script(programFirst ? program : function, label));
  Value second(script(programFirst ? function : program, label));
  JSAutoRealm realm(context, global->get());
  JS::RootedObject a(context, object(first.handle)), b(context, object(second.handle));
  uint32_t lineA = 0, lineB = 0;
  JS::TaggedColumnNumberOneOrigin columnA, columnB;
  check(JS::GetSavedFrameLine(context, nullptr, a, &lineA) == JS::SavedFrameResult::Ok &&
        JS::GetSavedFrameLine(context, nullptr, b, &lineB) == JS::SavedFrameResult::Ok &&
        JS::GetSavedFrameColumn(context, nullptr, a, &columnA) == JS::SavedFrameResult::Ok &&
        JS::GetSavedFrameColumn(context, nullptr, b, &columnB) == JS::SavedFrameResult::Ok, "collision coordinates");
  printf("frame-kind coordinates order=%s a=%u:%u b=%u:%u\n", programFirst ? "program-first" : "function-first",
         lineA, columnA.oneOriginValue(), lineB, columnB.oneOriginValue());
  equal_kind_identity(a, b);
  check(a != b, "same-position cross-kind frames never intern together");
  check(frame_kind(a) == (programFirst ? FrameKind::Program : FrameKind::Function) &&
        frame_kind(b) == (programFirst ? FrameKind::Function : FrameKind::Program), "capture order preserves kind");
  uint32_t line = 0;
  JS::TaggedColumnNumberOneOrigin column;
  check(JS::GetSavedFrameLine(context, nullptr, a, &line) == JS::SavedFrameResult::Ok && line == 1 &&
        JS::GetSavedFrameColumn(context, nullptr, a, &column) == JS::SavedFrameResult::Ok && column.oneOriginValue() == 14,
        "native callback captures its actual script call site");
  Value againA(script(programFirst ? program : function, label));
  Value againB(script(programFirst ? function : program, label));
  check(object(againA.handle) == a && object(againB.handle) == b, "equal-kind frames still share despite new script IDs");
  check(JSCLASS_RESERVED_SLOTS(JS::GetClass(a)) == 9, "eight old slots plus appended kind");
  JS::ubi::Node node(a.get());
  const auto bytes = node.size([](const void*) -> size_t { return 0; });
  printf("frame-kind collision order=%s line=%u column=%u slots=9 cellBytes=%llu\n", programFirst ? "program-first" : "function-first",
         line, column.oneOriginValue(), static_cast<unsigned long long>(bytes));
  check(sizeof(void*) == 4 && bytes == 112, "wasm32 SavedFrame allocation is 112 bytes, formerly 80");
}

void kind_error(const char* source, FrameKind expected, const char* expectedName = nullptr) {
  run_named("/kind-categories.ts", source);
  JSAutoRealm realm(context, global->get());
  JS::RootedObject frame(context, global_error_stack("kindError"));
  check(frame_kind(frame) == expected, source);
  JS::RootedString name(context);
  check(JS::GetSavedFrameFunctionDisplayName(context, nullptr, frame, &name) == JS::SavedFrameResult::Ok, "category name");
  check(expectedName ? name && string_bytes(name) == expectedName : !name, "true display name is unchanged");
}

void frame_kind_categories() {
  kind_error("globalThis.kindError = new Error()", FrameKind::Program);
  kind_error("eval('globalThis.kindError = new Error()')", FrameKind::Program);
  kind_error("(0,eval)('globalThis.kindError = new Error()')", FrameKind::Program);
  kind_error("(function(){ globalThis.kindError = new Error() })()", FrameKind::Function);
  kind_error("(()=>{ globalThis.kindError = new Error() })()", FrameKind::Function);
  kind_error("(function named(){ globalThis.kindError = new Error() })()", FrameKind::Function, "named");
  kind_error("new (function(){ globalThis.kindError = new Error() })()", FrameKind::Function);
  kind_error("new (function Named(){ globalThis.kindError = new Error() })()", FrameKind::Function, "Named");
  kind_error("Function('globalThis.kindError = new Error()')()", FrameKind::Function, "anonymous");
  kind_error("(function*(){ globalThis.kindError = new Error(); yield 1 })().next()", FrameKind::Function);
  kind_error("(async function(){ globalThis.kindError = new Error() })()", FrameKind::Function);
  const char* source = "globalThis.kindError = new Error(); export const value = 1;";
  bsm_handle out = 0;
  check(bsm_eval_module(source, strlen(source), "/kind-module.ts", 15, &out), "module category runs");
  Value evaluation(out);
  jobs();
  JSAutoRealm realm(context, global->get());
  JS::RootedObject frame(context, global_error_stack("kindError"));
  check(frame_kind(frame) == FrameKind::Program, "module body is Program");
  Value wasm(script("typeof WebAssembly"));
  size_t length = 0;
  const char* type = bsm_string_data(wasm.handle, &length);
  check(std::string(type, length) == "undefined", "update genuine Wasm control if shipped profile enables Wasm");
  puts("frame-kind Wasm unavailable in shipped profile; no synthetic Wasm evidence");
}

void frame_kind_lifetime() {
  bsm_gc();
  bsm_gc();
  const unsigned adds = provenanceAdds, releases = provenanceReleases;
  JS::SetScriptPrivateReferenceHooks(JS_GetRuntime(context), provenance_private_add, provenance_private_release);
  run_named("/kind-retained.ts", "globalThis.kindRetainedProgram = new Error('program');");
  run_named("/kind-retained.ts", "(function(){ globalThis.kindRetainedFunction = new Error('function'); })();");
  bsm_gc();
  bsm_gc();
  JS::SetScriptPrivateReferenceHooks(JS_GetRuntime(context), nullptr, nullptr);
  check(provenanceAdds - adds == 2 && provenanceReleases - releases == 2, "retained Errors outlive both scripts and their privates");
  JSAutoRealm realm(context, global->get());
  JS::RootedObject program(context, global_error_stack("kindRetainedProgram"));
  JS::RootedObject function(context, global_error_stack("kindRetainedFunction"));
  check(frame_kind(program) == FrameKind::Program && frame_kind(function) == FrameKind::Function, "kind survives script collection");
  Value formatted(script(
      "if (provenanceFormatter.errorFrames(kindRetainedProgram, kindRetainedProgram.stack)[0].name !== '') throw 'program name';"
      "if (provenanceFormatter.errorFrames(kindRetainedFunction, kindRetainedFunction.stack)[0].name !== '') throw 'function name';"
      "if (!provenanceFormatter.formatError(kindRetainedFunction).includes('at <anonymous> (/kind-retained.ts:')) throw 'anonymous label';"
      "if (provenanceFormatter.formatError(kindRetainedProgram).includes('at <anonymous>')) throw 'program label';"));
  printf("frame-kind lifetime privateAdds=%u privateReleases=%u\n", provenanceAdds - adds, provenanceReleases - releases);
}

void kind_copy(JS::HandleObject original, FrameKind expected, const mozilla::Maybe<size_t>& limit) {
  JS::RootedString cause(context, JS_NewStringCopyZ(context, "frame-kind"));
  JS::RootedObject copy(context);
  check(JS::CopyAsyncStack(context, original, cause, &copy, limit), "copy async kind");
  check(copy != original && frame_kind(copy) == expected, "async copied youngest preserves kind");
  JS::RootedString actualCause(context);
  check(JS::GetSavedFrameAsyncCause(context, nullptr, copy, &actualCause) == JS::SavedFrameResult::Ok &&
        string_bytes(actualCause) == "frame-kind", "async copy cause");
  same_position(original, copy);
  JS::RootedObject parent(context), originalParent(context);
  check(JS::GetSavedFrameParent(context, nullptr, original, &originalParent) == JS::SavedFrameResult::Ok &&
        JS::GetSavedFrameParent(context, nullptr, copy, &parent) == JS::SavedFrameResult::Ok, "async copy parents");
  if (limit.isSome()) { check(!parent, "full truncated path removes parent"); return; }
  check(parent == originalParent, "same-realm fast path shares unchanged parent");
}

void frame_kind_async_and_reentry() {
  run_named("/kind-async.ts", "(function(){ globalThis.kindError = new Error(); })()");
  JSAutoRealm realm(context, global->get());
  JS::RootedObject function(context, global_error_stack("kindError"));
  kind_copy(function, FrameKind::Function, mozilla::Nothing());
  kind_copy(function, FrameKind::Function, mozilla::Some(size_t(1)));
  run_named("/kind-async.ts", "globalThis.kindError = new Error();");
  JS::RootedObject program(context, global_error_stack("kindError"));
  kind_copy(program, FrameKind::Program, mozilla::Nothing());
  run_named("/kind-async-child.ts", "globalThis.kindChild = function child(){ globalThis.kindError = new Error(); };");
  JS::RootedValue callback(context), ignored(context);
  JS::RootedObject target(context, global->get());
  check(JS_GetProperty(context, target, "kindChild", &callback), "async callback");
  for (JSObject* original : {program.get(), function.get()}) {
    JS::RootedObject parent(context, original);
    const auto expected = frame_kind(parent);
    {
      JS::AutoSetAsyncStackForNewCalls async(context, parent, "kind-parent");
      check(JS::Call(context, JS::UndefinedHandleValue, callback, JS::HandleValueArray::empty(), &ignored), "async capture");
    }
    JS::RootedObject child(context, global_error_stack("kindError")), adopted(context);
    check(JS::GetSavedFrameAsyncParent(context, nullptr, child, &adopted) == JS::SavedFrameResult::Ok && adopted &&
          adopted != parent && frame_kind(adopted) == expected, "captured async parent preserves kind");
  }
  JS::RealmOptions options;
  JS::RootedObject other(context, JS_NewGlobalObject(context, &globalClass, nullptr, JS::DontFireOnNewGlobalHook, options));
  check(other != nullptr, "cross-realm global");
  {
    JSAutoRealm foreign(context, other);
    check(JS::InitRealmStandardClasses(context), "cross-realm standard classes");
    JS::RootedString cause(context, JS_NewStringCopyZ(context, "cross-kind"));
    JS::RootedObject copy(context), parent(context);
    check(JS::CopyAsyncStack(context, function, cause, &copy, mozilla::Nothing()) && frame_kind(copy) == FrameKind::Function,
          "cross-realm full-copy function");
    check(JS::GetSavedFrameParent(context, nullptr, copy, &parent) == JS::SavedFrameResult::Ok && parent &&
          frame_kind(parent) == FrameKind::Program, "cross-realm full-copy program parent");
  }
  kind_error("[1].map(function mapped(){ globalThis.kindError = new Error() })", FrameKind::Function, "mapped");
  JS::RootedObject frame(context, global_error_stack("kindError")), selfHosted(context);
  check(JS::GetSavedFrameParent(context, nullptr, frame, &selfHosted, includeSelfHosted) == JS::SavedFrameResult::Ok && selfHosted,
        "kind self-hosted frame");
  check(frame_kind(selfHosted, includeSelfHosted) == FrameKind::Function &&
        read_frame(selfHosted, includeSelfHosted).raw == "self-hosted", "Include selects builtin function");
  check(frame_kind(selfHosted, excludeSelfHosted) == FrameKind::Program &&
        read_frame(selfHosted, excludeSelfHosted).raw == "/kind-categories.ts", "Exclude selects same program as source");
  Value reentry(script("globalThis.kindOuter = captureKind(true); [1].map(() => { globalThis.kindInner = captureKind(); }); globalThis.kindAfter = captureKind();"));
  // Native capture reenters while another SavedFrame is retained, then repeats the outer capture.
  for (const char* property : {"kindOuter", "kindInner", "kindAfter", "kindReentered"}) {
    JS::RootedValue value(context);
    check(JS_GetProperty(context, target, property, &value) && value.isObject(), "reentry capture value");
    JS::RootedObject saved(context, &value.toObject());
    check(frame_kind(saved) == ((!strcmp(property, "kindInner") || !strcmp(property, "kindReentered")) ? FrameKind::Function : FrameKind::Program), "reentry kind");
  }
}

void frame_kind_reconstruction() {
  JSAutoRealm realm(context, global->get());
  Value captured(script("(function(){ captureKind() })()", "/kind-clone.ts"));
  JS::RootedObject frame(context, object(captured.handle));
  JS::RootedValue input(context, JS::ObjectValue(*frame)), output(context);
  check(JS_StructuredClone(context, input, &output, nullptr, nullptr) && output.isObject(), "clone real SavedFrame");
  JS::RootedObject clone(context, &output.toObject());
  check(frame_kind(clone) == FrameKind::Unknown && clone != frame, "valid clone has Ok Unknown distinct from Function");
  check(read_frame(clone).kind == displayKind && read_frame(clone).raw == "/kind-clone.ts", "clone label stays opaque");
  same_position(frame, clone);
  JS::RootedString name(context);
  check(JS::GetSavedFrameFunctionDisplayName(context, nullptr, clone, &name) == JS::SavedFrameResult::Ok && !name,
        "clone keeps null display name");
  JS::EnableRecordingAllocations(context, [](JS::RecordAllocationInfo&&) {}, 1.0);
  Value allocation(script("(function(){ return {}; })()", "/kind-live-ubi.ts"));
  JS::RootedObject allocated(context, object(allocation.handle)), live(context), again(context);
  JS::ubi::Node node(allocated.get());
  check(node.hasAllocationStack(), "recorded allocation has a live SavedFrame stack");
  JS::Rooted<JS::ubi::StackFrame> ubi(context, node.allocationStack());
  check(ubi.get().constructSavedFrameStack(context, &live) && live && frame_kind(live) == FrameKind::Function,
        "live ubi preserves anonymous Function kind");
  check(ubi.get().constructSavedFrameStack(context, &again) && again == live, "live ubi wraps the same SavedFrame");
  JS::DisableRecordingAllocations(context);
  JS::ubi::FrameKindOffline offline;
  JS::Rooted<JS::ubi::StackFrame> generic(context, JS::ubi::StackFrame(&offline));
  JS::RootedObject reconstructed(context);
  check(generic.get().constructSavedFrameStack(context, &reconstructed) && frame_kind(reconstructed) == FrameKind::Unknown &&
        read_frame(reconstructed).kind == displayKind, "generic ubi slow reconstruction is accessible Unknown");
  JS::RootedObject none(context), prototype(context);
  FrameKind kind = FrameKind::Function;
  check(JS::GetSavedFrameKind(context, nullptr, none, &kind) == JS::SavedFrameResult::AccessDenied && kind == FrameKind::Unknown,
        "null is AccessDenied Unknown, distinct from reconstructed Ok Unknown");
  check(JS_GetPrototype(context, frame, &prototype) && !js::IsSavedFrame(prototype), "prototype is invalid accessor input; never invoke getter");
}

void frame_kind_controls() {
  {
    JSAutoRealm realm(context, global->get());
    JS::RootedObject target(context, global->get());
    check(JS_DefineFunction(context, target, "captureKind", capture_kind, 0, 0) != nullptr, "install capture callback");
  }
  frame_kind_collision(true);
  frame_kind_collision(false);
  frame_kind_categories();
  frame_kind_lifetime();
  frame_kind_async_and_reentry();
  frame_kind_reconstruction();
  puts("SpiderMonkey SavedFrame frame kind controls passed");
}
}  // namespace
