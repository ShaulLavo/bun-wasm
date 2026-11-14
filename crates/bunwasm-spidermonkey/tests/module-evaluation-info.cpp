#include "jsfriendapi.h"
#include "js/Context.h"
#include "js/Modules.h"
#include "js/Promise.h"

static JSContext* contextWithJobs(uint32_t maxBytes) {
  JSContext* cx = JS_NewContext(maxBytes);
  if (!cx || !js::UseInternalJobQueues(cx)) abort();
  return cx;
}

// Internal queues must be installed before the standalone setup initializes
// self-hosting. Keep its tier and quota setup unchanged.
#define JS_NewContext contextWithJobs
#include "../cpp/shim.cpp"
#undef JS_NewContext

extern "C" const uint8_t __stack_low, __stack_high;
extern "C" bool bunsm_host_interrupt() { return false; }
extern "C" [[noreturn]] void bunsm_host_fatal(const char* text, size_t length) {
  fprintf(stderr, "fatal %.*s\n", static_cast<int>(length), text);
  abort();
}

using State = JS::ModuleEvaluationState;
static_assert(sizeof(State) == sizeof(uint8_t));

static void info(JSObject* module, State state, bool entered, bool recursed) {
  const auto result = JS::GetModuleEvaluationInfo(module);
  require(result.state == state, "evaluation state");
  require(result.bodyEntered == entered, "body entry");
  require(result.overRecursed == recursed, "stored over-recursion report");
}

static JSObject* compile(const char* source) {
  JS::SourceText<mozilla::Utf8Unit> text;
  require(text.init(context, source, strlen(source), JS::SourceOwnership::Borrowed), "source");
  JS::CompileOptions options(context);
  options.setFileAndLine("module-info.mjs", 1);
  JSObject* module = JS::CompileModule(context, options, text);
  require(module, "compile module");
  return module;
}

static void link(JS::HandleObject module) {
  JS::RootedObject loading(context);
  require(JS::LoadRequestedModules(context, module, JS::UndefinedHandleValue, &loading), "load graph");
  js::RunJobs(context);
  require(JS::GetPromiseState(loading) == JS::PromiseState::Fulfilled, "loaded graph");
  require(JS::ModuleLink(context, module), "link module");
}

static JSObject* evaluate(JS::HandleObject module) {
  JS::RootedValue result(context);
  require(JS::ModuleEvaluate(context, module, &result), "evaluate module");
  require(result.isObject(), "evaluation promise");
  return &result.toObject();
}

static void successful() {
  JS::RootedObject module(context, compile("export const answer = 42;"));
  info(module, State::Unevaluated, false, false);
  link(module);
  info(module, State::Unevaluated, false, false);
  JS::RootedObject promise(context, evaluate(module));
  info(module, State::Fulfilled, true, false);
  require(JS::GetPromiseState(promise) == JS::PromiseState::Fulfilled, "fulfilled evaluation");
  JS_GC(context);
  info(module, State::Fulfilled, true, false);
}

static void failed(const char* source, bool recursed) {
  JS::RootedObject module(context, compile(source));
  link(module);
  JS::RootedObject promise(context, evaluate(module));
  require(JS::GetPromiseState(promise) == JS::PromiseState::Rejected, "rejected evaluation");
  require(JS::SetSettledPromiseIsHandled(context, promise), "owned control rejection");
  JS::RootedValue sentinel(context, JS::Int32Value(73));
  JS_SetPendingException(context, sentinel);
  info(module, State::Failed, true, recursed);
  JS::RootedValue preserved(context);
  require(JS_GetPendingException(context, &preserved) && preserved == sentinel, "query preserves pending exception");
  JS_ClearPendingException(context);
  JS_GC(context);
  info(module, State::Failed, true, recursed);
}

static void pending() {
  JS::RootedObject module(context, compile("await new Promise(r => globalThis.resume = r); export const answer = 42;"));
  link(module);
  JS::RootedObject promise(context, evaluate(module));
  info(module, State::Pending, true, false);
  uint32_t status = 0;
  bsm_handle resumed = bsm_eval("resume()", 8, &status);
  require(status == 0, "resume TLA");
  bsm_release(resumed);
  js::RunJobs(context);
  require(JS::GetPromiseState(promise) == JS::PromiseState::Fulfilled, "resumed evaluation");
  info(module, State::Fulfilled, true, false);
}

static void synthetic() {
  JS::RootedValue value(context, JS::Int32Value(42));
  JS::RootedObject module(context, JS::CreateDefaultExportSyntheticModule(context, value));
  require(module, "synthetic record");
  info(module, State::Fulfilled, false, false);
  link(module);
  JS::RootedObject promise(context, evaluate(module));
  require(JS::GetPromiseState(promise) == JS::PromiseState::Fulfilled, "synthetic evaluation");
  info(module, State::Fulfilled, false, false);
}

int main(int argc, char** argv) {
  require(argc == 2, "explicit tier");
  const bool pbl = strcmp(argv[1], "pbl") == 0;
  require(pbl || strcmp(argv[1], "interp") == 0, "valid tier");
  bsm_config config{reinterpret_cast<uintptr_t>(&__stack_low), reinterpret_cast<uintptr_t>(&__stack_high),
                    512 * 1024 * 1024, static_cast<uint8_t>(pbl), 1};
  bsm_init(&config);
  {
    JSAutoRealm realm(context, *global);
    successful();
    pending();
    synthetic();
    failed("throw undefined;", false);
    failed("throw 17;", false);
    failed("throw new RangeError('too much recursion');", false);
    failed("throw new Proxy({}, { get() { throw 'query read a property'; } });", false);
    failed("function recurse() { recurse(); } recurse();", true);
  }
  require(pbl ? bsm_pbl_entries() > 0 : bsm_pbl_entries() == 0, "selected tier engaged");
  bsm_shutdown();
  printf("module evaluation info passed tier=%s\n", argv[1]);
}
