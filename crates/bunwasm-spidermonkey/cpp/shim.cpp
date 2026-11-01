#include "shim.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <vector>
#include "jsapi.h"
#include "js/CompilationAndEvaluation.h"
#include "js/Context.h"
#include "js/Exception.h"
#include "js/GCAPI.h"
#include "js/GlobalObject.h"
#include "js/Initialization.h"
#include "js/Interrupt.h"
#include "js/Realm.h"
#include "js/PropertyAndElement.h"
#include "js/SourceText.h"
#include "js/Stack.h"
#include "mozilla/mozalloc.h"

extern "C" bool bunsm_host_interrupt();
extern "C" [[noreturn]] void bunsm_host_fatal(const char*, size_t);
static JSContext* context;
static JS::PersistentRootedObject* global;
static std::vector<JS::PersistentRootedValue*> handles;
static uintptr_t stackBase;
static bool interruptible;
static bool terminating;
static uint32_t checks[2];
static uint32_t pblEntries;
static const JSClass globalClass = {"BunG2", JSCLASS_GLOBAL_FLAGS, &JS::DefaultGlobalClassOps};

extern "C" void bunsm_vm_fatal(const char* text) {
  bunsm_host_fatal(text, strlen(text));
}
extern "C" void* bunsm_stack_base() { return reinterpret_cast<void*>(stackBase); }
extern "C" void bunsm_poll_interrupt(JSContext* cx, uint8_t tier) {
  if (!interruptible) return;
  if (++checks[tier] % 10000 != 0) return;
  if (!bunsm_host_interrupt()) return;
  terminating = true;
  JS_RequestInterruptCallback(cx);
}
extern "C" void bunsm_pbl_entry() { ++pblEntries; }
static bool interruptCallback(JSContext*) { return !terminating; }
static void require(bool ok, const char* message) { if (!ok) bunsm_vm_fatal(message); }

extern "C" void bsm_init(const bsm_config* config) {
  stackBase = config->stack_high;
  interruptible = config->interruptible;
  require(JS_Init(), "JS_Init failed");
  context = JS_NewContext(config->max_gc_bytes);
  require(context != nullptr, "JS_NewContext failed");
  JS_SetGlobalJitCompilerOption(context, JSJITCOMPILER_PORTABLE_BASELINE_ENABLE, config->tier);
  JS_SetGlobalJitCompilerOption(context, JSJITCOMPILER_PORTABLE_BASELINE_WARMUP_THRESHOLD, 0);
  require(config->stack_high > config->stack_low + 65536, "invalid stack bounds");
  JS_SetNativeStackQuota(context, config->stack_high - config->stack_low - 65536);
  require(JS::InitSelfHostedCode(context), "self-hosted initialization failed");
  JS::RealmOptions options;
  JS::RootedObject object(context, JS_NewGlobalObject(context, &globalClass, nullptr, JS::FireOnNewGlobalHook, options));
  require(object != nullptr, "global creation failed");
  global = new JS::PersistentRootedObject(context, object);
  JSAutoRealm realm(context, object);
  require(JS::InitRealmStandardClasses(context), "standard classes failed");
  if (interruptible) require(JS_AddInterruptCallback(context, interruptCallback), "interrupt callback failed");
}
extern "C" bsm_handle bsm_eval(const char* source, size_t len, uint32_t* status) {
  JSAutoRealm realm(context, *global);
  terminating = false;
  JS::SourceText<mozilla::Utf8Unit> text;
  require(text.init(context, source, len, JS::SourceOwnership::Borrowed), "source init failed");
  JS::CompileOptions options(context);
  options.setFileAndLine("spidermonkey-g2.js", 1);
  JS::RootedValue result(context);
  bool ok = JS::Evaluate(context, options, text, &result);
  *status = ok ? 0 : 1;
  if (!ok && !JS_IsExceptionPending(context)) { *status = 2; return 0; }
  if (!ok) { require(JS_GetPendingException(context, &result), "pending exception failed"); JS_ClearPendingException(context); }
  handles.push_back(new JS::PersistentRootedValue(context, result));
  return handles.size();
}
extern "C" void bsm_release(bsm_handle handle) {
  if (!handle) return;
  delete handles.at(handle - 1);
  handles.at(handle - 1) = nullptr;
}
extern "C" double bsm_number(bsm_handle handle) { return handles.at(handle - 1)->get().toNumber(); }
extern "C" double bsm_answer(bsm_handle handle) {
  JSAutoRealm realm(context, *global);
  JS::RootedObject object(context, &handles.at(handle - 1)->get().toObject());
  JS::RootedValue answer(context);
  require(JS_GetProperty(context, object, "answer", &answer), "read rooted object");
  return answer.toNumber();
}
extern "C" void bsm_gc() { JS_GC(context); }
extern "C" uint32_t bsm_poll_count(uint8_t tier) { return checks[tier]; }
extern "C" uint32_t bsm_pbl_entries() { return pblEntries; }
extern "C" void bsm_force_oom() { void* p = moz_xmalloc(SIZE_MAX - 65535); free(p); }
extern "C" void bsm_shutdown() {
  for (auto* value : handles) delete value;
  handles.clear();
  delete global;
  JS_DestroyContext(context);
  JS_ShutDown();
}
