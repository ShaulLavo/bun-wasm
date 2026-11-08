#include "../cpp/engine.h"

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <unordered_map>
#include <vector>

extern "C" const uint8_t __stack_low, __stack_high;

namespace {
std::unordered_map<std::string, std::string> sources;
std::vector<bsm_handle> rejected;
std::vector<uint32_t> finalized;
unsigned interruptCalls = 0;
unsigned interruptAt = 0;

void check(bool ok, const char* label) {
  if (ok) return;
  fprintf(stderr, "FAIL %s\n", label);
  abort();
}

class Value {
 public:
  bsm_handle handle;
  explicit Value(bsm_handle handle) : handle(handle) { check(handle != 0, "nonzero handle"); }
  ~Value() { bsm_release(handle); }
  Value(const Value&) = delete;
  Value& operator=(const Value&) = delete;
};

Value script(const char* source, const char* filename = "semantics", int32_t line = 1) {
  bsm_handle out = 0;
  bool ok = bsm_eval_script(source, strlen(source), filename, line, &out);
  check(ok, source);
  return Value(out);
}

void install(const char* name, bsm_handle handle) {
  Value global(bsm_global());
  bsm_handle error = 0;
  check(bsm_set(global.handle, name, strlen(name), handle, &error), "install global");
}

void jobs() {
  bsm_handle error = 0;
  bsm_drain_jobs(&error);
  check(error == 0 && !bsm_terminated(), "drain without uncaught exception");
}

Value import(const char* specifier) {
  bsm_handle out = 0;
  check(bsm_import(specifier, strlen(specifier), &out), "top-level import");
  return Value(out);
}

void module_promise_poisoning(bool useImport, bool throwingGetter) {
  const std::string name = std::string("poison-") + (useImport ? "import" : "eval") + (throwingGetter ? "-getter" : "-removed");
  sources[name] = "export let answer; await new Promise(r => globalThis.resumeSlow = r); answer = 42;";
  Value saved(script("globalThis.moduleThenReads = 0; globalThis.savedThenDescriptor = Object.getOwnPropertyDescriptor(Promise.prototype, 'then');"));
  const char* poison = throwingGetter
      ? "Object.defineProperty(Promise.prototype, 'then', { configurable: true, get() { moduleThenReads++; throw 'public then'; } });"
      : "Promise.prototype.then = undefined;";
  Value changed(script(poison));
  bsm_handle out = 0;
  if (useImport) check(bsm_import(name.data(), name.size(), &out), "poisoned module import");
  else check(bsm_eval_module(sources[name].data(), sources[name].size(), name.data(), name.size(), &out), "poisoned direct module eval");
  Value pending(out);
  jobs();
  check(bsm_promise_state(pending.handle) == 0, "internal evaluation waits for unresolved TLA");
  Value resume(script("resumeSlow();"));
  jobs();
  check(bsm_promise_state(pending.handle) == 1, "internal evaluation fulfills with public then still changed");
  Value restore(script("Object.defineProperty(Promise.prototype, 'then', savedThenDescriptor); if (moduleThenReads !== 0) throw new Error('internal promise used public then');"));
}

void modules() {
  module_promise_poisoning(true, false);
  module_promise_poisoning(true, true);
  module_promise_poisoning(false, false);
  module_promise_poisoning(false, true);
  sources["dep"] = "export const answer = await Promise.resolve(42);";
  sources["entry"] = "import {answer} from 'dep'; export {answer}; globalThis.executions = (globalThis.executions || 0) + 1;";
  sources["dynamic"] = "export default import('entry').then(ns => ns.answer);";
  sources["broken"] = "import 'absent';";
  Value entry(import("entry"));
  check(bsm_promise_state(entry.handle) == 0, "import initially pending");
  jobs();
  check(bsm_promise_state(entry.handle) == 1, "TLA import fulfilled");
  Value ns(bsm_promise_result(entry.handle));
  install("namespaceValue", ns.handle);
  Value checkNs(script("if (namespaceValue.answer !== 42) throw new Error('namespace');"));
  Value again(import("entry"));
  jobs();
  Value same(bsm_promise_result(again.handle));
  check(bsm_same_value(ns.handle, same.handle), "namespace identity");
  Value once(script("if (executions !== 1) throw new Error('evaluated twice');"));
  Value dynamic(import("dynamic"));
  jobs();
  Value dynamicNs(bsm_promise_result(dynamic.handle));
  install("dynamicNamespace", dynamicNs.handle);
  Value dynamicResult(script("globalThis.dynamicAnswer = 0; dynamicNamespace.default.then(v => dynamicAnswer = v);"));
  jobs();
  Value answer(script("if (dynamicAnswer !== 42) throw new Error('dynamic import');"));
  Value broken(import("broken"));
  jobs();
  check(bsm_promise_state(broken.handle) == 2, "missing dependency rejects asynchronously");
}

void contexts() {
  Value a(bsm_number_value(11));
  Value b(bsm_number_value(22));
  Value outer(bsm_number_value(33));
  Value pending(script("globalThis.frames = []; globalThis.trigger = null; globalThis.wait = new Promise(r => trigger = r);"));
  bsm_set_async_context(a.handle);
  Value first(script("wait.then(async () => { frames.push(readFrame()); await 0; frames.push(readFrame()); });"));
  bsm_set_async_context(b.handle);
  Value second(script("wait.then(() => { frames.push(readFrame()); Promise.resolve().then(() => frames.push(readFrame())); });"));
  bsm_set_async_context(outer.handle);
  Value fire(script("trigger();"));
  jobs();
  Value current(bsm_async_context());
  check(bsm_same_value(current.handle, outer.handle), "caller context restored");
  Value verify(script("if (frames.join(',') !== '11,22,11,22') throw new Error(frames.join(','));"));
}

void rejections() {
  rejected.clear();
  Value setup(script("globalThis.unhandled = Promise.reject('reason'); globalThis.handled = Promise.reject('handled'); Promise.resolve().then(() => handled.catch(() => {}));"));
  jobs();
  check(rejected.size() == 1, "same-checkpoint handler removes only its rejection");
  Value expected(script("unhandled"));
  check(bsm_same_value(rejected[0], expected.handle), "retained rejected promise identity");
  Value handle(script("unhandled.catch(() => {});"));
  jobs();
  check(rejected.empty(), "late handler removes pending rejection");
}

void promise_reactions() {
  Value promise(script("globalThis.nativePromise = Promise.resolve(9); Object.defineProperties(nativePromise, { then: { get() { throw 'public then'; } }, constructor: { get() { throw 'public constructor'; } } }); nativePromise"));
  Value handler(script("value => value * 2"));
  Value undefined(bsm_undefined());
  bsm_handle out = 0;
  check(bsm_promise_then(promise.handle, handler.handle, undefined.handle, &out), "native promise reactions ignore public getters");
  Value reaction(out);
  jobs();
  Value value(bsm_promise_result(reaction.handle));
  check(bsm_number(value.handle) == 18, "native promise reaction result");
  bsm_handle error = 0;
  check(!bsm_promise_then(undefined.handle, handler.handle, undefined.handle, &error), "nonpromise primitive rejected");
  Value wrongType(error);
  check(bsm_is_error(wrongType.handle), "nonpromise rejection is an error");
}

void buffers() {
  uint8_t memory[] = {1, 2, 3, 4};
  Value external(bsm_external_buffer(memory, sizeof(memory)));
  install("external", external.handle);
  check(!bsm_is_detachable_buffer(external.handle), "external transfer refused");
  Value pinned(script("globalThis.view = new Uint8Array(external); for (const name of ['transfer', 'transferToFixedLength', 'transferToImmutable']) { const fn = ArrayBuffer.prototype[name]; if (!fn) continue; let refused = false; try { Reflect.apply(fn, external, []); } catch (e) { refused = e instanceof TypeError; } if (!refused) throw new Error(name); } view[1] = 9;"));
  check(memory[1] == 9, "external bytes shared without copying");
  Value ordinary(script("globalThis.ordinary = new ArrayBuffer(4); ordinary"));
  check(!bsm_detach_external(ordinary.handle), "ordinary buffer is not external");
  check(bsm_is_detachable_buffer(ordinary.handle), "ordinary buffer transferable");
  bsm_detach_buffer(ordinary.handle);
  check(!bsm_detach_external(ordinary.handle), "unrelated detached buffer is not external");
  check(!bsm_is_detachable_buffer(ordinary.handle), "detached buffer not transferable");
  check(bsm_detach_external(external.handle), "detach external");
  check(bsm_detach_external(external.handle), "repeat external detach");
  Value detached(script("if (external.byteLength !== 0 || view.byteLength !== 0) throw new Error('views not detached');"));
  memory[1] = 7;
}

void commonjs_self_calls(const char* body) {
  const std::string wrapper = std::string("(function __bunwasm_cjs__(exports, require, module, __filename, __dirname) {\n\n") + body + "\n})";
  Value ordinary(script(wrapper.c_str(), "commonjs-self.cts", 1));
  Value adjusted(script(wrapper.c_str(), "commonjs-self.cts", -1));
  Value receiver(bsm_new_object());
  bsm_handle baseline = 0;
  bsm_handle actual = 0;
  check(bsm_call(ordinary.handle, receiver.handle, nullptr, 0, &baseline), "ordinary named self call");
  Value expected(baseline);
  check(bsm_call(adjusted.handle, receiver.handle, nullptr, 0, &actual), "adjusted named self call");
  Value observed(actual);
  check(bsm_same_value(expected.handle, observed.handle), "named self binding preserves recursive receiver and assignment");
}

void errors_and_lines() {
  commonjs_self_calls("\"use strict\"; if (exports) return this; return __bunwasm_cjs__(true);");
  commonjs_self_calls("if (exports) return this; return __bunwasm_cjs__(true);");
  commonjs_self_calls("\"use strict\"; try { __bunwasm_cjs__ = null; return false; } catch (e) { return e instanceof TypeError; }");
  commonjs_self_calls("const original = __bunwasm_cjs__; __bunwasm_cjs__ = null; return __bunwasm_cjs__ === original;");
  Value poison(script("globalThis.savedTypeError = TypeError; globalThis.TypeError = function () { throw 'poison'; };"));
  Value error(bsm_error(1, "native", 6));
  install("nativeError", error.handle);
  Value original(script("if (!(nativeError instanceof savedTypeError) || nativeError.message !== 'native') throw new Error('constructor'); globalThis.TypeError = savedTypeError;"));
  Value wrapper(script("(function __bunwasm_cjs__(exports, require, module, __filename, __dirname) {\n\nthrow new Error('commonjs');\n})", "commonjs.cts", -1));
  bsm_handle thrown = 0;
  Value undefined(bsm_undefined());
  check(!bsm_call(wrapper.handle, undefined.handle, nullptr, 0, &thrown), "CJS throws");
  Value caught(thrown);
  install("commonjsError", caught.handle);
  Value correct(script("if (!commonjsError.stack.includes('commonjs.cts:1:')) throw new Error(commonjsError.stack);"));
  Value positive(script("globalThis.classicStack = new Error('classic').stack;", "classic.ts", 17));
  Value shifted(script("if (!classicStack.includes('classic.ts:17:')) throw new Error(classicStack);"));
  Value zero(script("globalThis.zeroStack = new Error('zero').stack;", "zero.ts", 0));
  Value zeroLine(script("if (!zeroStack.includes('zero.ts:0:')) throw new Error(zeroStack);"));
  bsm_handle negative = 0;
  check(!bsm_eval_script("42", 2, "negative", -1, &negative), "unrecognized negative source refused");
  Value negativeError(negative);
  check(bsm_is_error(negativeError.handle), "negative source returns an error");
  Value semantics(script("(function __bunwasm_cjs__(exports, require, module, __filename, __dirname) {\n\nreturn [__bunwasm_cjs__, eval('__bunwasm_cjs__'), this, exports, require, module, __filename, __dirname, arguments.length];\n})", "commonjs-bindings.cts", -1));
  Value receiver(bsm_new_object());
  Value number(bsm_number_value(42));
  bsm_handle arguments[] = {number.handle, number.handle, number.handle, number.handle, number.handle};
  bsm_handle bindings = 0;
  check(bsm_call(semantics.handle, receiver.handle, arguments, 5, &bindings), "CommonJS body call");
  Value bodyResult(bindings);
  install("commonjsFunction", semantics.handle);
  install("commonjsBindings", bodyResult.handle);
  install("commonjsReceiver", receiver.handle);
  Value bound(script("if (commonjsFunction.name !== '__bunwasm_cjs__' || commonjsFunction.length !== 5 || commonjsBindings[0] !== commonjsFunction || commonjsBindings[1] !== commonjsFunction || commonjsBindings[2] !== commonjsReceiver || commonjsBindings.slice(3, 8).some(v => v !== 42) || commonjsBindings[8] !== 5) throw new Error('CommonJS bindings');"));
  bsm_handle failure = 0;
  check(!bsm_eval_script("throw 17", 8, "thrown", 1, &failure), "primitive exception");
  Value primitive(failure);
  check(bsm_number(primitive.handle) == 17, "exception value preserved");
  Value overflow(script("globalThis.overflowName = ''; try { (function recurse() { recurse(); })(); } catch (e) { overflowName = e.name; }"));
  Value range(script("if (overflowName !== 'RangeError') throw new Error(overflowName);"));
}

void natives() {
  {
    Value callback(bsm_function("owned", 5, 100));
    install("ownedNative", callback.handle);
  }
  bsm_gc();
  check(finalized.empty(), "live function owns native callback");
  Value call(script("if (ownedNative(21) !== 42) throw new Error('callback'); globalThis.ownedNative = null;"));
  bsm_gc();
  bsm_gc();
  check(finalized.size() == 1 && finalized[0] == 100, "native finalizer exactly once");
}
}  // namespace

extern "C" bool bunsm_host_call(uint32_t id, bsm_handle, const bsm_handle* args, size_t argc, bsm_handle* out) {
  if (id == 1) { *out = bsm_async_context(); return true; }
  check(id == 100 && argc == 1, "native callback arguments");
  *out = bsm_number_value(bsm_number(args[0]) * 2);
  return true;
}
extern "C" void bunsm_host_drop(uint32_t id) { finalized.push_back(id); }
extern "C" bool bunsm_host_resolve(const char* spec, size_t size, const char*, size_t, char** out, size_t* length, bsm_handle*) {
  *out = static_cast<char*>(malloc(size));
  memcpy(*out, spec, size);
  *length = size;
  return true;
}
extern "C" bool bunsm_host_load(const char* name, size_t size, char** out, size_t* length, bsm_handle* error) {
  auto found = sources.find(std::string(name, size));
  if (found == sources.end()) { *error = bsm_error(0, "module absent", 13); return false; }
  *length = found->second.size();
  *out = static_cast<char*>(malloc(*length));
  memcpy(*out, found->second.data(), *length);
  return true;
}
extern "C" void bunsm_host_free(char* text) { free(text); }
extern "C" bool bunsm_host_init_meta(const char*, size_t, bsm_handle, bsm_handle*) { return true; }
extern "C" bool bunsm_host_interrupt() { return interruptAt && ++interruptCalls >= interruptAt; }
extern "C" void bunsm_host_rejection(bsm_handle promise, bsm_handle, bool handled) {
  if (!handled) { rejected.push_back(bsm_dup(promise)); return; }
  for (auto it = rejected.begin(); it != rejected.end(); ++it) {
    if (!bsm_same_value(*it, promise)) continue;
    bsm_release(*it);
    rejected.erase(it);
    return;
  }
}
extern "C" void bunsm_host_uncaught(bsm_handle) { check(false, "unexpected uncaught exception"); }
extern "C" [[noreturn]] void bunsm_host_fatal(const char* text, size_t length) {
  fprintf(stderr, "fatal %.*s\n", static_cast<int>(length), text);
  abort();
}

int main() {
  const char* tier = getenv("BUN_WASM_SPIDERMONKEY_TIER");
  bsm_config config{reinterpret_cast<uintptr_t>(&__stack_low), reinterpret_cast<uintptr_t>(&__stack_high), 512 * 1024 * 1024,
      static_cast<uint8_t>(tier && !strcmp(tier, "pbl")), 1};
  finalized.reserve(16);
  bsm_init(&config);
  {
    Value read(bsm_function("readFrame", 9, 1));
    install("readFrame", read.handle);
    modules();
    for (auto promise : rejected) bsm_release(promise);
    rejected.clear();
    contexts();
    rejections();
    promise_reactions();
    buffers();
    errors_and_lines();
    natives();
    interruptAt = 1;
    bsm_handle interrupted = 0;
    const char* loop = "globalThis.caught = false; globalThis.finallyRan = false; try { while (true) {} } catch { caught = true; } finally { finallyRan = true; }";
    check(!bsm_eval_script(loop, strlen(loop), "interrupt", 1, &interrupted), "uncatchable interrupt");
    check(interrupted == 0 && bsm_terminated(), "interrupt has no catchable exception");
    Value global(bsm_global());
    bsm_handle caught = 0;
    check(bsm_get(global.handle, "caught", 6, &caught), "read caught flag");
    Value caughtValue(caught);
    check(!bsm_bool_value(caughtValue.handle), "interrupt bypasses catch");
    bsm_handle finalized = 0;
    check(bsm_get(global.handle, "finallyRan", 10, &finalized), "read finally flag");
    Value finallyValue(finalized);
    check(!bsm_bool_value(finallyValue.handle), "interrupt bypasses finally");
    check(interruptCalls == 1, "host interruption latched once");
  }
  bsm_shutdown();
  puts("SpiderMonkey Engine semantics passed");
}
