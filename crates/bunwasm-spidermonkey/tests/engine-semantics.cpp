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
std::vector<bsm_handle> uncaught;
std::vector<bool> rejectionEvents;
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
  if (error) bunsm_host_uncaught(error);
  bsm_release(error);
  check(uncaught.empty() && !bsm_terminated(), "drain without uncaught exception");
}

Value import(const char* specifier) {
  bsm_handle out = 0;
  check(bsm_import(specifier, strlen(specifier), &out), "top-level import");
  return Value(out);
}

Value require(const char* specifier) {
  bsm_handle out = 0;
  check(bsm_require(specifier, strlen(specifier), &out), "top-level require");
  return Value(out);
}

struct RequirePromises {
  bsm_handle loading = 0, bridge = 0, evaluation = 0, derived = 0;
  RequirePromises() {
    bsm_control_require_promises(&loading, &bridge, &evaluation, &derived);
  }
  ~RequirePromises() {
    bsm_release(loading);
    bsm_release(bridge);
    bsm_release(evaluation);
    bsm_release(derived);
  }
};

struct RequireOutcome {
  int kind;
  bsm_handle value;
  ~RequireOutcome() { bsm_release(value); }
};

void drain_observed() {
  bsm_handle error = 0;
  bsm_drain_jobs(&error);
  if (error) bunsm_host_uncaught(error);
  bsm_release(error);
}

bool drain_some() {
  bsm_handle error = 0;
  bool ran = bsm_drain_jobs(&error);
  if (error) bunsm_host_uncaught(error);
  bsm_release(error);
  return ran;
}

RequireOutcome control_require_promise(bsm_handle out) {
  while (bsm_promise_state(out) == 0 && !bsm_terminated()) {
    if (!drain_some()) break;
  }
  int state = bsm_promise_state(out);
  if (state == 2) {
    bsm_handle reason = bsm_promise_result(out);
    bsm_release(out);
    return {1, reason};
  }
  if (state == 0) {
    bsm_release(out);
    const char message[] = "require() async module is unsupported";
    return {2, bsm_error(1, message, sizeof(message) - 1)};
  }
  bsm_handle result = bsm_promise_result(out);
  bsm_release(out);
  return {0, result};
}

RequireOutcome control_require(const char* name) {
  bsm_handle out = 0;
  if (!bsm_require(name, strlen(name), &out)) return {-1, out};
  return control_require_promise(out);
}

void arm_fault(const char* site, uint32_t nth = 1, uint32_t kind = 1) {
  bsm_control_fault(site, nth, kind);
}

void clear_fault() { bsm_control_fault(nullptr, 0, 0); }

void reset_reports() {
  for (auto promise : rejected) bsm_release(promise);
  for (auto error : uncaught) bsm_release(error);
  rejected.clear();
  uncaught.clear();
  rejectionEvents.clear();
}

void check_repeat(const char* name) {
  clear_fault();
  reset_reports();
  RequireOutcome repeated = control_require(name);
  check(repeated.kind == 0 && rejected.empty() && uncaught.empty(), "ordinary require after fault");
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

void internal_promise_poisoning(int mode, int poison) {
  const std::string name = "owned-" + std::to_string(mode) + "-" + std::to_string(poison);
  sources[name] = poison == 3
      ? "export let answer; await { then(r) { globalThis.resumeSlow = r; } }; answer = 42;"
      : "export let answer; await new Promise(r => globalThis.resumeSlow = r); answer = 42;";
  Value saved(script("globalThis.moduleThenReads = 0; globalThis.moduleConstructorReads = 0; globalThis.moduleSpeciesReads = 0; globalThis.savedThenDescriptor = Object.getOwnPropertyDescriptor(Promise.prototype, 'then'); globalThis.savedConstructorDescriptor = Object.getOwnPropertyDescriptor(Promise.prototype, 'constructor'); globalThis.savedSpeciesDescriptor = Object.getOwnPropertyDescriptor(Promise, Symbol.species);"));
  const char* changes[] = {
      "Promise.prototype.then = undefined;",
      "Object.defineProperty(Promise.prototype, 'then', { configurable: true, get() { moduleThenReads++; throw 'public then'; } });",
      "Promise.prototype.then = function () { moduleThenReads++; };",
      "Object.defineProperty(Promise.prototype, 'constructor', { configurable: true, get() { moduleConstructorReads++; throw 'public constructor'; } });",
      "Object.defineProperty(Promise, Symbol.species, { configurable: true, get() { moduleSpeciesReads++; throw 'public species'; } });",
  };
  Value changed(script(changes[poison]));
  bsm_handle out = 0;
  if (mode == 0) check(bsm_import(name.data(), name.size(), &out), "poisoned owned import");
  if (mode == 1) check(bsm_eval_module(sources[name].data(), sources[name].size(), name.data(), name.size(), &out), "poisoned owned eval");
  if (mode == 2) check(bsm_require(name.data(), name.size(), &out), "poisoned owned require");
  Value pending(out);
  jobs();
  check(bsm_promise_state(pending.handle) == 0, "owned internal evaluation waits for TLA");
  if (mode == 2) {
    RequirePromises promises;
    check(promises.derived != 0 && bsm_same_value(promises.bridge, pending.handle), "require exposes its derived pending pipeline");
  }
  Value resume(script("resumeSlow();"));
  jobs();
  check(bsm_promise_state(pending.handle) == 1, "sealed internal evaluation fulfills");
  if (mode != 1) {
    Value ns(bsm_promise_result(pending.handle));
    install("ownedNamespace", ns.handle);
    Value answer(script("if (ownedNamespace.answer !== 42) throw new Error('owned namespace');"));
  }
  Value restore(script("Object.defineProperty(Promise.prototype, 'then', savedThenDescriptor); Object.defineProperty(Promise.prototype, 'constructor', savedConstructorDescriptor); if (savedSpeciesDescriptor) Object.defineProperty(Promise, Symbol.species, savedSpeciesDescriptor); else delete Promise[Symbol.species]; if (moduleThenReads + moduleConstructorReads + moduleSpeciesReads !== 0) throw new Error('internal adoption read public promise properties');"));
  check(rejected.empty() && uncaught.empty(), "owned poisoning has no rejection report");
}

void module_cases() {
  module_promise_poisoning(true, false);
  module_promise_poisoning(true, true);
  module_promise_poisoning(false, false);
  module_promise_poisoning(false, true);
  for (int poison = 0; poison < 3; ++poison) internal_promise_poisoning(2, poison);
  for (int mode = 0; mode < 3; ++mode) {
    internal_promise_poisoning(mode, 3);
    internal_promise_poisoning(mode, 4);
  }
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

void require_faults() {
  sources["fault-basic"] = "export const answer = 42;";
  sources["fault-pending-f5"] = "export let answer; await 0; answer = 42;";
  sources["fault-pending-f6"] = sources["fault-pending-f5"];
  sources["fault-pending-f6b1"] = sources["fault-pending-f5"];
  sources["fault-pending-f6b2"] = sources["fault-pending-f5"];
  sources["fault-pending-f8"] = sources["fault-pending-f5"];
  sources["fault-pending-f17"] = sources["fault-pending-f5"];
  sources["fault-then"] = "export function then(resolve) { globalThis.thenCalls = (globalThis.thenCalls || 0) + 1; resolve(7); }";
  sources["fault-then-tla"] = "await 0; export function then(resolve) { globalThis.thenCalls = (globalThis.thenCalls || 0) + 1; resolve(7); }";

  arm_fault("requireSetup:require-handler");
  RequireOutcome f1 = control_require("fault-basic");
  RequirePromises f1p;
  check(f1.kind == -1 && f1p.loading && !f1p.bridge && rejected.empty(), "F1 handler allocation");
  check_repeat("fault-basic");

  arm_fault("requireSetup:load-requested");
  RequireOutcome f2 = control_require("fault-basic");
  check(f2.kind == -1 && rejected.empty() && uncaught.empty(), "F2 load requested allocation");
  check_repeat("fault-basic");

  sources["fault-first"] = "export const first = 1;";
  sources["fault-second"] = "export const second = 2;";
  sources["fault-parent"] = "import 'fault-first'; import 'fault-second'; export const answer = 42;";
  reset_reports();
  arm_fault("requireSetup:module-load", 2);
  RequireOutcome f3 = control_require("fault-parent");
  check(f3.kind == 1 && rejected.empty() && rejectionEvents.size() == 2 && !rejectionEvents[0] && rejectionEvents[1], "F3 loading rejection is handled");
  check_repeat("fault-parent");

  arm_fault("requireSetup:host-defined");
  RequireOutcome f4 = control_require("fault-basic");
  check(f4.kind == -1 && rejected.empty() && uncaught.empty(), "F4 require reaction allocation");
  check_repeat("fault-basic");

  arm_fault("requireDerived:host-defined");
  RequireOutcome f5 = control_require("fault-pending-f5");
  RequirePromises f5p;
  check(f5.kind == 1 && f5p.evaluation && !f5p.derived && rejected.empty() && uncaught.empty(), "F5 derived reaction allocation");
  check_repeat("fault-pending-f5");

  arm_fault("requireLoaded:require-namespace-handler");
  RequireOutcome f6 = control_require("fault-pending-f6");
  check(f6.kind == 1 && rejected.empty() && uncaught.empty(), "F6 namespace handler allocation");
  check_repeat("fault-pending-f6");

  for (uint32_t nth = 1; nth <= 2; ++nth) {
    arm_fault("requireLoaded:seal", nth);
    std::string name = "fault-pending-f6b" + std::to_string(nth);
    RequireOutcome f6b = control_require(name.c_str());
    RequirePromises promises;
    check(f6b.kind == 1 && promises.derived && bsm_promise_state(promises.derived) == 1 && rejected.empty() && uncaught.empty(), "F6b derived seal");
    check_repeat(name.c_str());
  }

  arm_fault("requireNamespaceGet:namespace-get");
  RequireOutcome f7 = control_require("fault-basic");
  check(f7.kind == 1 && rejected.empty() && uncaught.empty(), "F7 namespace allocation");
  check_repeat("fault-basic");

  arm_fault("bridgeAdoptD:host-defined");
  RequireOutcome f8 = control_require("fault-pending-f8");
  RequirePromises f8p;
  check(f8.kind == 2 && uncaught.size() == 1 && rejected.empty() && bsm_promise_state(f8p.bridge) == 0, "F8 bridge adoption enqueue");
  check_repeat("fault-pending-f8");

  arm_fault("bridgeNamespace:host-defined");
  RequireOutcome f9 = control_require("fault-then");
  check(f9.kind == 2 && uncaught.size() == 1 && rejected.empty(), "F9 namespace thenable enqueue");
  check_repeat("fault-then");

  arm_fault("derivedNamespace:host-defined");
  RequireOutcome f9b = control_require("fault-then-tla");
  RequirePromises f9bp;
  check(f9b.kind == 2 && uncaught.size() == 1 && rejected.empty() && bsm_promise_state(f9bp.derived) == 0 && bsm_promise_state(f9bp.bridge) == 0, "F9b derived namespace enqueue");
  check_repeat("fault-then-tla");

  arm_fault("requireLoaded:silent-return", 1, 2);
  RequireOutcome f10 = control_require("fault-basic");
  check(f10.kind == 2 && uncaught.empty() && rejected.empty(), "F10 silent reaction failure");
  check_repeat("fault-basic");

  arm_fault("bridgeAdoptD:host-defined", 2);
  RequireOutcome f17 = control_require("fault-pending-f17");
  check(f17.kind == 1 && uncaught.empty() && rejected.empty(), "F17 built-in bridge adoption allocation");
  check_repeat("fault-pending-f17");
}

void import_faults() {
  sources["fault-import"] = "export let answer; await 0; answer = 42;";
  bsm_handle out = 0;
  arm_fault("importSetup:host-defined");
  check(!bsm_import("fault-import", 12, &out) && out && rejected.empty(), "F12 import reaction allocation");
  bsm_release(out);

  for (uint32_t nth = 1; nth <= 2; ++nth) {
    reset_reports();
    out = 0;
    arm_fault(nth == 1 ? "importForward:host-defined" : "importForward:seal");
    check(bsm_import("fault-import", 12, &out), "F12c import begins");
    drain_observed();
    check(bsm_promise_state(out) == 2 && uncaught.empty(), "F12c evaluation rejects");
    check(bsm_control_mark_handled(out) && rejected.empty(), "F12c owned internal promises");
    bsm_release(out);
  }

  reset_reports();
  out = 0;
  arm_fault("importAdoptE:host-defined", 2);
  check(bsm_import("fault-import", 12, &out), "F12b import begins");
  drain_observed();
  check(bsm_promise_state(out) == 2 && uncaught.empty(), "F12b built-in adoption rejects evaluation");
  check(bsm_control_mark_handled(out) && rejected.empty(), "F12b tracker scrub");
  bsm_release(out);
  clear_fault();
}

void n3_fault() {
  sources["n3"] = "export let then; globalThis.armThen = f => { then = f; }; await 0;";
  reset_reports();
  bsm_handle bridge = 0;
  check(bsm_require("n3", 2, &bridge), "F18 require begins");
  check(bsm_control_run_until("require-namespace-returned"), "F18 namespace reaction returned");
  Value armed(script("armThen(function () {});"));
  arm_fault("derivedNamespace:host-defined");
  drain_observed();
  RequirePromises promises;
  check(bsm_promise_state(bridge) == 0 && uncaught.empty() && rejected.size() == 1, "F18 temporary rejection report");
  check(!bsm_same_value(rejected[0], promises.loading) && !bsm_same_value(rejected[0], promises.bridge) && !bsm_same_value(rejected[0], promises.evaluation) && !bsm_same_value(rejected[0], promises.derived), "F18 report is not a require promise");
  bsm_release(bridge);
  clear_fault();
  reset_reports();
}

void termination_fault() {
  sources["fault-terminate"] = "export const answer = 42;";
  arm_fault("requireLoaded:terminate-return", 1, 3);
  RequireOutcome outcome = control_require("fault-terminate");
  check(outcome.kind == 2 && bsm_terminated() && rejected.empty() && uncaught.empty(), "F11 terminated require stays owned");
}

using DepthCallback = void (*)(void*);
[[gnu::noinline]] void at_native_depth(size_t bytes, DepthCallback callback, void* state) {
  auto* frame = static_cast<volatile unsigned char*>(__builtin_alloca(bytes + 16));
  frame[0] = bytes;
  callback(state);
  if (frame[0] == 255) fprintf(stderr, "depth frame\n");
}

[[gnu::noinline]] void at_native_depth_coarse(size_t bytes, DepthCallback callback, void* state) {
  at_native_depth(bytes, callback, state);
}

struct S15Sweep {
  size_t serial = 0;
  bool failed = false;
  bool target = false;
  std::string current;
  bsm_handle bridge = 0;
  std::string targetName;
  bsm_handle error = 0;
};

void s15_probe(void* opaque) {
  auto& state = *static_cast<S15Sweep*>(opaque);
  reset_reports();
  RequireOutcome outcome = control_require_promise(state.bridge);
  RequirePromises promises;
  check(rejected.empty() && uncaught.empty(), "S15 generic ownership");
  if (outcome.kind != 0) state.failed = true;
  bool entered = bsm_control_require_entered();
  if (outcome.kind != 1 || entered || !promises.loading || bsm_promise_state(promises.loading) != 1 ||
      bsm_promise_state(promises.bridge) != 2 || bsm_control_module_linked(state.current.data(), state.current.size())) return;
  state.target = true;
  state.targetName = state.current;
  bsm_release(state.error);
  state.error = bsm_dup(outcome.value);
}

void s15_iteration(S15Sweep& state, size_t depth, bool coarse = false) {
  state.current = "s15-" + std::to_string(state.serial++);
  sources[state.current] = "globalThis.s15Runs = (globalThis.s15Runs || 0) + 1; export const answer = 42;";
  reset_reports();
  check(bsm_require(state.current.data(), state.current.size(), &state.bridge), "S15 shallow bridge setup");
  state.failed = false;
  if (coarse) at_native_depth_coarse(depth, s15_probe, &state);
  else at_native_depth(depth, s15_probe, &state);
}

void check_range_error(bsm_handle error) {
  install("rangeProbe", error);
  Value checkError(script("if (!(rangeProbe instanceof RangeError) || rangeProbe.message !== 'too much recursion') throw new Error('expected engine recursion refusal');"));
}

void s15_sweep() {
  S15Sweep state;
  size_t firstFailure = static_cast<size_t>(-1);
  for (size_t depth = 0; depth <= 8 * 1024 * 1024; depth += 4096) {
    s15_iteration(state, depth, true);
    if (!state.failed) continue;
    firstFailure = depth;
    break;
  }
  check(firstFailure != static_cast<size_t>(-1), "S15 coarse refusal");
  size_t start = firstFailure > 4096 ? firstFailure - 4096 : 0;
  for (size_t depth = start; depth <= firstFailure + 256 && !state.target; depth += 16) {
    s15_iteration(state, depth);
  }
  check(state.target && state.error, "S15 require_loaded entry refusal");
  check_range_error(state.error);
  reset_reports();
  RequireOutcome retry = control_require(state.targetName.c_str());
  check(retry.kind == 0 && rejected.empty() && uncaught.empty(), "S15 shallow retry");
  bsm_release(state.error);
}

struct S16Sweep {
  size_t serial = 0;
  bool pending;
  bool failed = false;
  bool found[2] = {};
  std::string current;
  std::string names[2];
  bsm_handle errors[2] = {};
};

void s16_deep(void* opaque) {
  auto& state = *static_cast<S16Sweep*>(opaque);
  drain_observed();
  RequirePromises promises;
  check(rejected.empty(), "S16 tracker empty");
  int bridge = bsm_promise_state(promises.bridge);
  int derived = state.pending ? bsm_promise_state(promises.derived) : bridge;
  state.failed = bridge != 1;
  if (bridge == 1) {
    Value result(bsm_promise_result(promises.bridge));
    state.failed = bsm_number(result.handle) != 7;
  }
  int target = -1;
  if (bridge == 2 && derived == 2 && uncaught.empty()) target = 0;
  if (bridge == 0 && derived == 0 && uncaught.size() == 1) target = 1;
  if (target < 0 || state.found[target]) return;
  state.found[target] = true;
  state.names[target] = state.current;
  bsm_release(state.errors[target]);
  if (target == 0) {
    Value reason(bsm_promise_result(promises.bridge));
    state.errors[target] = bsm_dup(reason.handle);
  } else {
    state.errors[target] = bsm_dup(uncaught[0]);
  }
}

void s16_finish_targets(S16Sweep& state) {
  for (int target = 0; target < 2; ++target) {
    if (state.names[target].empty()) continue;
    check_range_error(state.errors[target]);
    reset_reports();
    RequireOutcome retry = control_require(state.names[target].c_str());
    check(retry.kind == 0 && bsm_number(retry.value) == 7 && rejected.empty() && uncaught.empty(), "S16 shallow repeat");
    state.names[target].clear();
  }
}

void s16_iteration(S16Sweep& state, size_t depth, bool coarse = false) {
  std::string name = "s16-" + std::to_string(state.pending) + "-" + std::to_string(state.serial++);
  sources[name] = state.pending
      ? "await 0; export function then(resolve) { globalThis.thenCalls++; resolve(globalThis.value); }"
      : "export function then(resolve) { globalThis.thenCalls++; resolve(globalThis.value); }";
  state.current = name;
  Value setup(script("globalThis.thenCalls = 0; globalThis.value = 7;"));
  reset_reports();
  bsm_handle bridge = 0;
  check(bsm_require(name.data(), name.size(), &bridge), "S16 require setup");
  Value owned(bridge);
  check(bsm_control_run_until(state.pending ? "require-namespace-returned" : "require-loaded-returned"), "S16 isolated thenable job");
  reset_reports();
  state.failed = false;
  if (coarse) at_native_depth_coarse(depth, s16_deep, &state);
  else at_native_depth(depth, s16_deep, &state);
  s16_finish_targets(state);
}

void s16_sweep(bool pending) {
  S16Sweep state;
  state.pending = pending;
  size_t firstFailure = static_cast<size_t>(-1);
  for (size_t depth = 0; depth <= 8 * 1024 * 1024; depth += 4096) {
    s16_iteration(state, depth, true);
    if (!state.failed) continue;
    firstFailure = depth;
    break;
  }
  check(firstFailure != static_cast<size_t>(-1), "S16 coarse refusal");
  size_t start = firstFailure > 4096 ? firstFailure - 4096 : 0;
  for (size_t depth = start; depth <= firstFailure + 4096 && (!state.found[0] || !state.found[1]); depth += 16) {
    s16_iteration(state, depth);
  }
  check(state.found[0] && state.found[1], "S16 reject success and reject-entry refusal");
  for (auto error : state.errors) bsm_release(error);
}

void heap_fault(bool pending) {
  const char* name = pending ? "heap-then-tla" : "heap-then";
  sources[name] = pending
      ? "await 0; export function then(resolve) { globalThis.thenCalls++; resolve(7); }"
      : "export function then(resolve) { globalThis.thenCalls++; resolve(7); }";
  Value setup(script("globalThis.thenCalls = 0;"));
  bsm_handle bridge = 0;
  check(bsm_require(name, strlen(name), &bridge), "F19 require setup");
  Value owned(bridge);
  check(bsm_control_run_until(pending ? "require-namespace-returned" : "require-loaded-returned"), "F19 thenable job queued");
  reset_reports();
  RequirePromises promises;
  bsm_control_fill_heap();
  drain_observed();
  bsm_heap_report report;
  bsm_control_heap_report(&report);
  check(report.gcCycles == 0 && report.lastDitchCycles == 0 && report.ooms == 1 &&
        report.firstOomJobsEntered == 1 && report.firstOomInJob && report.jobsEntered == 1,
        "F19 refusal occurs in the first drained job without GC");
  check(uncaught.size() == 1 && rejected.empty() && bsm_promise_state(bridge) == 0, "F19 resolving-function exhaustion");
  if (pending) check(bsm_promise_state(promises.derived) == 0, "F19 derived stays pending");
  bsm_control_release_heap();
  size_t oomLength = 0;
  const char* oom = bsm_string_data(uncaught[0], &oomLength);
  check(oomLength == 13 && memcmp(oom, "out of memory", 13) == 0, "F19 exact OOM value");
  Value global(bsm_global());
  bsm_handle calls = 0;
  check(bsm_get(global.handle, "thenCalls", 9, &calls) && bsm_number(calls) == 0, "F19 user then not entered");
  bsm_release(calls);
  drain_observed();
  check(uncaught.size() == 1 && rejected.empty() && bsm_promise_state(bridge) == 0, "F19 extra drain leaves the bridge pending");
  if (pending) check(bsm_promise_state(promises.derived) == 0, "F19 derived pending after release");
  reset_reports();
  RequireOutcome retry = control_require(name);
  check(retry.kind == 0 && bsm_number(retry.value) == 7 && rejected.empty() && uncaught.empty(), "F19 shallow repeat");
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
  Value pinned(script("globalThis.view = new Uint8Array(external); for (const name of ['transfer', 'transferToFixedLength', 'transferToImmutable']) { const fn = ArrayBuffer.prototype[name]; if (!fn) continue; let refused = false; try { Reflect.apply(fn, external, []); } catch (e) { refused = e instanceof RangeError; } if (!refused) throw new Error(name); } view[1] = 9;"));
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
#include "require-recovery.cpp"
#if defined(BUNSM_LOOP_CONTROLS)
#include "loop-dispatch.cpp"
#endif

}  // namespace

extern "C" bool bunsm_host_call(uint32_t id, bsm_handle, const bsm_handle* args, size_t argc, bsm_handle* out) {
  if (id == 1) { *out = bsm_async_context(); return true; }
  if (id == 200 || id == 201) return recovery_host_call(id, args, argc, out);
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
  rejectionEvents.push_back(handled);
  if (!handled) { rejected.push_back(bsm_dup(promise)); return; }
  for (auto it = rejected.begin(); it != rejected.end(); ++it) {
    if (!bsm_same_value(*it, promise)) continue;
    bsm_release(*it);
    rejected.erase(it);
    return;
  }
}
extern "C" void bunsm_host_uncaught(bsm_handle value) { uncaught.push_back(bsm_dup(value)); }
extern "C" [[noreturn]] void bunsm_host_fatal(const char* text, size_t length) {
  fprintf(stderr, "fatal %.*s\n", static_cast<int>(length), text);
  // abort() is redirected through mozalloc back into this hook; trap so the backtrace survives.
  __builtin_trap();
}

extern "C" int engine_semantics_main() {
  const char* tier = getenv("BUN_WASM_SPIDERMONKEY_TIER");
  const char* mode = getenv("BUNSM_CONTROL_MODE");
  bool heapMode = mode && (!strcmp(mode, "heap-sync") || !strcmp(mode, "heap-pending"));
  bsm_config config{reinterpret_cast<uintptr_t>(&__stack_low), reinterpret_cast<uintptr_t>(&__stack_high), static_cast<uint32_t>(heapMode ? 18 * 1024 * 1024 : 512 * 1024 * 1024),
      static_cast<uint8_t>(tier && !strcmp(tier, "pbl")), 1};
  finalized.reserve(16);
  bsm_init(&config);
#if defined(BUNSM_LOOP_CONTROLS)
  loop_controls();
  bsm_shutdown();
  puts("SpiderMonkey loop controls passed");
  return 0;
#endif
  if (mode && !strcmp(mode, "fault-terminate")) {
    termination_fault();
    bsm_shutdown();
    puts("SpiderMonkey termination control passed");
    return 0;
  }
  if (heapMode) {
    heap_fault(!strcmp(mode, "heap-pending"));
    bsm_shutdown();
    puts("SpiderMonkey heap-exhaustion control passed");
    return 0;
  }
  if (mode && !strcmp(mode, "recovery")) {
    recovery_controls();
    bsm_shutdown();
    puts("SpiderMonkey require recovery controls passed");
    return 0;
  }
  if (mode && !strcmp(mode, "recovery-terminate")) {
    recovery_termination();
    bsm_shutdown();
    puts("SpiderMonkey require termination control passed");
    return 0;
  }
  if (mode && !strcmp(mode, "recovery-map-trap")) {
    recovery_map_trap();
    return 1;
  }
  {
    Value read(bsm_function("readFrame", 9, 1));
    install("readFrame", read.handle);
    module_cases();
    for (auto promise : rejected) bsm_release(promise);
    rejected.clear();
    require_faults();
    import_faults();
    n3_fault();
    s15_sweep();
    s16_sweep(false);
    s16_sweep(true);
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
  return 0;
}
