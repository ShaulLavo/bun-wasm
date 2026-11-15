#include "jsapi.h"
#include "js/CharacterEncoding.h"
#include "js/CompilationAndEvaluation.h"
#include "js/Context.h"
#include "js/Conversions.h"
#include "js/Exception.h"
#include "js/GlobalObject.h"
#include "js/Initialization.h"
#include "js/Realm.h"
#include "js/SourceText.h"
#include "js/Stack.h"
#include "suppressed-error-source.h"
#include <cstdio>
#include <cstring>

extern "C" const unsigned char __stack_low, __stack_high;
static unsigned long long entries;
extern "C" void* bunsm_stack_base() { return const_cast<unsigned char*>(&__stack_high); }
extern "C" void bunsm_poll_interrupt(JSContext*, uint8_t) {}
extern "C" void bunsm_pbl_entry() { ++entries; }
extern "C" void bunsm_vm_fatal(const char* text) { std::fprintf(stderr, "%s\n", text); __builtin_trap(); }
extern "C" void bunsm_host_fatal(const char* text, size_t size) { std::fwrite(text, 1, size, stderr); __builtin_trap(); }
static const JSClass globalClass = {"SuppressedErrorControl", JSCLASS_GLOBAL_FLAGS, &JS::DefaultGlobalClassOps};

static void check(bool ok, const char* label) {
  if (ok) return;
  std::fprintf(stderr, "FAIL %s\n", label);
  __builtin_trap();
}

static void evaluate(JSContext* cx) {
  JS::SourceText<mozilla::Utf8Unit> text;
  check(text.init(cx, source, std::strlen(source), JS::SourceOwnership::Borrowed), "source text");
  JS::CompileOptions options(cx);
  options.setFileAndLine("suppressed-error-order/index.ts", 1);
  JS::RootedValue result(cx);
  const bool ok = JS::Evaluate(cx, options, text, &result);
  std::fprintf(stderr, "JSAPI disposal evaluation: portable_baseline_entries=%llu\n", entries);
  if (!ok) {
    JS::RootedValue exception(cx);
    check(JS_GetPendingException(cx, &exception), "pending exception");
    JS_ClearPendingException(cx);
    JS::RootedString message(cx, JS::ToString(cx, exception));
    check(message != nullptr, "exception string");
    JS::UniqueChars encoded(JS_EncodeStringToUTF8(cx, message));
    std::fprintf(stderr, "%s\n", encoded ? encoded.get() : "exception encoding failed");
  }
  check(ok, "JSAPI disposal assertions");
  check(result.isString(), "fixture completion string");
  JS::RootedString message(cx, result.toString());
  JS::UniqueChars encoded(JS_EncodeStringToUTF8(cx, message));
  check(encoded && !std::strcmp(encoded.get(), "suppressed error controls passed"), "fixture completion");
}

int main(int argc, char** argv) {
  check(argc == 2 && (!std::strcmp(argv[1], "interp") || !std::strcmp(argv[1], "pbl")), "explicit interp or pbl tier");
  const bool pbl = !std::strcmp(argv[1], "pbl");
  check(JS_Init(), "initialize engine");
  JSContext* cx = JS_NewContext(256 * 1024 * 1024);
  check(cx != nullptr, "context");
  JS_SetGlobalJitCompilerOption(cx, JSJITCOMPILER_PORTABLE_BASELINE_ENABLE, pbl);
  JS_SetGlobalJitCompilerOption(cx, JSJITCOMPILER_PORTABLE_BASELINE_WARMUP_THRESHOLD, 0);
  JS_SetNativeStackQuota(cx, &__stack_high - &__stack_low - 65536);
  check(JS::InitSelfHostedCode(cx), "self hosted code");
  {
    JS::RealmOptions options;
    JS::RootedObject global(cx, JS_NewGlobalObject(cx, &globalClass, nullptr, JS::FireOnNewGlobalHook, options));
    check(global != nullptr, "global");
    JSAutoRealm realm(cx, global);
    check(JS::InitRealmStandardClasses(cx), "standard classes");
    evaluate(cx);
  }
  std::printf("suppressed error JSAPI controls passed; tier=%s portable_baseline_entries=%llu\n", argv[1], entries);
  check(pbl ? entries > 0 : entries == 0, "selected tier exercised");
  JS_DestroyContext(cx);
  JS_ShutDown();
}
