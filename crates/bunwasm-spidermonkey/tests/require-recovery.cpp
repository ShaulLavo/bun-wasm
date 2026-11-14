// Unit 3 controls of the SpiderMonkey require-recovery design: the 8.2.4 schedules, the
// JavaScript-depth form of 8.2.1 and fault rows F13-F16 of 8.3. engine-semantics.cpp includes
// this file inside its anonymous namespace. Every sweep iteration uses fresh module names,
// because pinned failures stay cached by design.

enum : uint32_t { kUnevaluated = 0, kPending = 1, kFulfilled = 2, kFailed = 3 };
constexpr size_t kNoDepth = static_cast<size_t>(-1);
constexpr int kAfterEvaluation = -2;

size_t recoverySerial = 0;
bsm_handle hostImportFunction = 0;
bsm_handle hostRequireFunction = 0;
bsm_handle hostImported = 0;
unsigned hostRequireFailures = 0;
unsigned hostRequireCalls = 0;
std::string pendingName;

std::string fresh(const std::string& label) { return label + "-" + std::to_string(recoverySerial++); }
std::string literal(const std::string& text) { return "'" + text + "'"; }

bool contains(const std::vector<std::string>& list, const std::string& name) {
  for (const auto& entry : list) {
    if (entry == name) return true;
  }
  return false;
}

void counted_module(const std::string& name, const std::vector<std::string>& deps, const std::string& body) {
  std::string source;
  for (const auto& dep : deps) source += "import " + literal(dep) + "; ";
  std::string key = "globalThis.recoveryRuns[" + literal(name) + "]";
  sources[name] = source + key + " = (" + key + " || 0) + 1; " + body;
}

// A top-level-await body that makes no call: it awaits a gate the driver creates at shallow
// depth, so its body reaches the await at about the stack cost of its own entry.
std::string awaiting(const std::string& name) {
  std::string source = "globalThis.recoveryGates[" + literal(name) + "] = new Promise(r => { globalThis.recoveryResolvers[" +
      literal(name) + "] = r; });";
  Value gate(script(source.c_str()));
  return "await globalThis.recoveryGates[" + literal(name) + "]; export const value = 1;";
}

bsm_module_info info(const std::string& name) {
  bsm_module_info out;
  bsm_control_module_info(name.c_str(), &out);
  return out;
}

std::vector<bsm_module_info> infos(const std::vector<std::string>& names) {
  std::vector<bsm_module_info> out;
  for (const auto& name : names) out.push_back(info(name));
  return out;
}

int body_runs(const std::string& name) {
  std::string source = "globalThis.recoveryRuns[" + literal(name) + "] || 0";
  Value runs(script(source.c_str()));
  return static_cast<int>(bsm_number(runs.handle));
}

bool recursion_error(bsm_handle error) {
  install("rangeProbe", error);
  Value result(script("rangeProbe instanceof RangeError && rangeProbe.message === 'too much recursion'"));
  return bsm_bool_value(result.handle);
}

bsm_handle global_value_handle(const char* name) {
  Value global(bsm_global());
  bsm_handle out = 0;
  check(bsm_get(global.handle, name, strlen(name), &out), "read global");
  return out;
}

double namespace_value(bsm_handle ns) {
  bsm_handle value = 0;
  check(bsm_get(ns, "value", 5, &value), "read namespace value");
  Value owned(value);
  return bsm_number(owned.handle);
}

void resolve_pending(const std::string& name) {
  std::string key = "globalThis.recoveryResolvers[" + literal(name) + "]";
  std::string source = "{ const resolve = " + key + "; delete " + key + "; if (resolve) resolve(); }";
  Value done(script(source.c_str()));
  jobs();
}

size_t stack_room() {
  volatile char marker = 0;
  return reinterpret_cast<uintptr_t>(&marker) - reinterpret_cast<uintptr_t>(&__stack_low);
}

// Host natives: hostImport (200) is the runtime-lowered sequence of 8.2.1, one promise job and
// then bsm_import from inside it. It keeps the import's promise for the control, as its caller.
// hostRequire (201) mirrors require_esm, so a module body can make a nested require.
bool host_import(const std::string& name, bsm_handle* out) {
  bsm_handle promise = 0;
  if (!bsm_import(name.data(), name.size(), &promise)) {
    *out = promise;
    return false;
  }
  check(bsm_control_mark_handled(promise), "hostImport's caller owns its promise");
  bsm_release(hostImported);
  hostImported = promise;
  *out = bsm_undefined();
  return true;
}

bool host_require(const std::string& name, bsm_handle* out) {
  ++hostRequireCalls;
  RequireOutcome result = control_require(name.c_str());
  *out = result.value ? bsm_dup(result.value) : 0;
  if (result.kind == 0) return true;
  ++hostRequireFailures;
  return false;
}

bool recovery_host_call(uint32_t id, const bsm_handle* args, size_t argc, bsm_handle* out) {
  check(argc == 1, "recovery host natives take one module name");
  size_t length = 0;
  const char* data = bsm_string_data(args[0], &length);
  check(data != nullptr, "recovery host natives take a string");
  std::string name(data, length);
  return id == 200 ? host_import(name, out) : host_require(name, out);
}

void queue_host_import(bsm_handle resolved) {
  Value none(bsm_undefined());
  bsm_handle derived = 0;
  check(bsm_promise_then(resolved, hostImportFunction, none.handle, &derived), "schedule hostImport");
  check(bsm_control_mark_handled(derived), "hostImport reaction is driver scaffolding");
  bsm_release(derived);
}

void schedule_host_import(const std::string& name) {
  std::string source = "Promise.resolve(" + literal(name) + ")";
  Value resolved(script(source.c_str()));
  queue_host_import(resolved.handle);
}

// The native-import setup of 8.2.1: a classic script's import() loads P and its dependencies
// synchronously and leaves exactly one queued job, dynamic_module_loaded(P).
bsm_handle native_import_setup(const std::string& name) {
  std::string source = "globalThis.ip = import(" + literal(name) + ")";
  Value done(script(source.c_str()));
  Value global(bsm_global());
  bsm_handle ip = 0;
  check(bsm_get(global.handle, "ip", 2, &ip), "native import promise");
  check(bsm_control_mark_handled(ip), "native import caller owns its promise");
  return ip;
}

struct Observed {
  std::vector<std::string> names;
  std::vector<std::pair<std::string, std::string>> edges;
  std::vector<std::vector<bsm_module_info>> before, after;
  std::vector<std::vector<bool>> edgesBefore;
  std::vector<std::string> outcomes;
};
Observed* observing = nullptr;

void observe(const char* point) {
  if (!observing) return;
  if (!strcmp(point, "require-after-evaluate")) {
    observing->after.push_back(infos(observing->names));
    observing->outcomes.push_back(bsm_control_last_outcome());
    return;
  }
  if (strcmp(point, "require-before-evaluate")) return;
  observing->before.push_back(infos(observing->names));
  std::vector<bool> edges;
  for (const auto& edge : observing->edges) edges.push_back(bsm_control_edge(edge.first.c_str(), edge.second.c_str()));
  observing->edgesBefore.push_back(edges);
}

struct Run {
  std::vector<std::string> names;
  std::string root;
  Observed seen;
  int kind = 0;
  bsm_handle value = 0;
  bsm_handle bridge = 0;
  bool isolate = false;
  int jobRan = 0;
  std::string outcome;
  std::vector<bsm_module_info> start;
  Run() = default;
  Run(const Run&) = delete;
  Run& operator=(const Run&) = delete;
  ~Run() { bsm_release(value); }
  size_t at(const std::string& name) const {
    for (size_t i = 0; i < names.size(); ++i) {
      if (names[i] == name) return i;
    }
    check(false, "watched module name");
    return 0;
  }
  const bsm_module_info& before(const std::string& name) const { return seen.before.at(0).at(at(name)); }
  const bsm_module_info& now(const std::string& name) const { return start.at(at(name)); }
};

void store_outcome(Run& run, RequireOutcome& result) {
  run.kind = result.kind;
  bsm_release(run.value);
  run.value = result.value ? bsm_dup(result.value) : 0;
}

void deep_require(void* opaque) {
  auto& run = *static_cast<Run*>(opaque);
  if (run.isolate) {
    run.jobRan = bsm_control_run_one_job();
    return;
  }
  RequireOutcome result = control_require_promise(run.bridge);
  run.bridge = 0;
  store_outcome(run, result);
}

// Runs the require's drain beneath `depth` bytes of native stack, then records the outcome and
// the state of every watched record at shallow depth. bsm_require itself runs shallow, as in
// S15, so compilation is never what refuses. With `jobsBefore` >= 0, that many queued jobs run
// shallow first, only the next job (the require's own) runs deep, and the rest drain shallow.
void require_at(Run& run, size_t depth, bool coarse, int jobsBefore = -1) {
  run.seen.names = run.names;
  observing = &run.seen;
  bsm_control_observe(observe);
  check(bsm_require(run.root.data(), run.root.size(), &run.bridge), "shallow require setup");
  for (int i = 0; i < jobsBefore; ++i) check(bsm_control_run_one_job() == 1, "shallow job before the require");
  // kAfterEvaluation: run jobs shallow until the require's evaluation promise has settled, so the
  // next queued job is the reaction the require attached to it.
  for (bool settled = jobsBefore != kAfterEvaluation; !settled;) {
    check(bsm_control_run_one_job() == 1, "shallow job before the evaluation settles");
    RequirePromises promises;
    settled = promises.evaluation && bsm_promise_state(promises.evaluation) != 0;
  }
  run.isolate = jobsBefore >= 0 || jobsBefore == kAfterEvaluation;
  if (coarse) at_native_depth_coarse(depth, deep_require, &run);
  else at_native_depth(depth, deep_require, &run);
  if (run.isolate) {
    check(run.jobRan == 1, "the isolated require job completes");
    RequireOutcome result = control_require_promise(run.bridge);
    run.bridge = 0;
    store_outcome(run, result);
  }
  run.outcome = bsm_control_last_outcome();
  bsm_control_observe(nullptr);
  observing = nullptr;
  drain_observed();
  run.start = infos(run.names);
  size_t retired = 0;
  uint32_t active = 0;
  bsm_control_retirement(&retired, &active);
  check(!retired && !active, "retired entries are freed once no snapshot is active");
}

// "Repeat" (8.2.4): a shallow require, bsm_import and an import() from a fresh module all
// return the cached error by identity, and the generation does not change.
void repeat_cached(const std::string& name, bsm_handle error) {
  uint64_t generation = info(name).generation;
  RequireOutcome required = control_require(name.c_str());
  check(required.kind == 1 && bsm_same_value(required.value, error), "repeat require replays the cached error");
  Value imported(import(name.c_str()));
  check(bsm_control_mark_handled(imported.handle), "repeat import handled by its caller");
  jobs();
  Value importResult(bsm_promise_result(imported.handle));
  check(bsm_promise_state(imported.handle) == 2 && bsm_same_value(importResult.handle, error), "repeat bsm_import replays the cached error");
  std::string referrer = fresh(name + "-importer");
  sources[referrer] = "export const pending = import(" + literal(name) + ");";
  Value outer(import(referrer.c_str()));
  jobs();
  Value ns(bsm_promise_result(outer.handle));
  bsm_handle nested = 0;
  check(bsm_get(ns.handle, "pending", 7, &nested), "repeat import() promise");
  Value pending(nested);
  check(bsm_control_mark_handled(nested), "repeat import() handled by its caller");
  jobs();
  Value nestedResult(bsm_promise_result(nested));
  check(bsm_promise_state(nested) == 2 && bsm_same_value(nestedResult.handle, error), "repeat import() replays the cached error");
  check(info(name).generation == generation && rejected.empty(), "repeat keeps the generation and the tracker empty");
}

using Retry = void (*)(const std::string&);

void retry_plain(const std::string& root) {
  RequireOutcome retry = control_require(root.c_str());
  check(retry.kind == 0, "shallow retry returns the namespace");
}

void retry_after_pending(const std::string& root) {
  RequireOutcome first = control_require(root.c_str());
  check(first.kind == 2 || first.kind == 0, "shallow retry joins the pending dependency");
  resolve_pending(pendingName);
  RequireOutcome retry = control_require(root.c_str());
  check(retry.kind == 0, "retry returns the namespace once the dependency settles");
}

void report_tracker(const Run& run) {
  if (rejected.empty()) return;
  Value reason(bsm_promise_result(rejected[0]));
  fprintf(stderr, "%s: %zu tracker entries after [%d %s], first reason kind %u refusal %d\n", run.root.c_str(),
          rejected.size(), run.kind, run.outcome.c_str(), bsm_kind(reason.handle), recursion_error(reason.handle));
}

// Rollback: nothing failed stays mapped, the retry compiles a fresh root generation, and every
// retired record runs exactly once on that retry.
void verify_rollback(Run& run, const std::vector<std::string>& own, Retry retry) {
  check(!info(run.root).mapped, "rollback retires the root");
  for (size_t i = 0; i < run.names.size(); ++i) {
    bool checked = !contains(own, run.names[i]) && run.start[i].mapped;
    check(!checked || run.start[i].state != kFailed, "rollback leaves no failed record mapped");
  }
  uint64_t generation = run.before(run.root).generation;
  retry(run.root);
  check(info(run.root).generation > generation, "the retry compiles a fresh generation");
  for (size_t i = 0; i < run.names.size(); ++i) {
    bool retired = run.seen.before.at(0)[i].mapped && !run.start[i].mapped && !contains(own, run.names[i]);
    check(!retired || body_runs(run.names[i]) == 1, "a retired record runs once on retry");
  }
}

void verify_pinned(Run& run) {
  bool known = run.outcome.rfind("pinned", 0) == 0 && run.outcome != "pinned because evaluation returned false";
  if (!known) fprintf(stderr, "unexpected outcome %s\n", run.outcome.c_str());
  check(known, "known require outcome");
  bsm_module_info root = info(run.root);
  check(root.mapped && root.state == kFailed, "a pinned failure stays cached");
  repeat_cached(run.root, run.value);
}

// A rejected require: the outcome decides between a retry, a rollback check and a cached repeat.
void verify_rejection(Run& run, const std::vector<std::string>& own, Retry retry, bsm_handle inherited) {
  bool refusal = recursion_error(run.value);
  check(refusal || (inherited && bsm_same_value(run.value, inherited)), "the require rejects with a refusal or the inherited error");
  bsm_module_info root = info(run.root);
  if (run.outcome == "not entered" || run.outcome == "link failed") {
    // The root may already be linked by an import that holds it (S8); otherwise it is not.
    check(root.mapped && root.state == kUnevaluated && run.seen.before.empty(), "a refusal before evaluation leaves the root unevaluated");
    retry(run.root);
    return;
  }
  if (run.outcome == "no failure" && root.state == kFailed) {
    // The evaluation was still pending when ModuleEvaluate returned and failed later inside
    // the drain (condition 1): never rolled back, cached like any asynchronous failure.
    repeat_cached(run.root, run.value);
    return;
  }
  if (run.outcome == "no failure") {
    // A refusal after evaluation (the namespace step, or the pending branch's handler) leaves
    // the evaluation itself fulfilled or still pending and owned.
    check(root.mapped && (root.state == kFulfilled || root.state == kPending), "a refusal after evaluation leaves the records evaluated");
    retry(run.root);
    return;
  }
  if (run.outcome == "rolled back") {
    verify_rollback(run, own, retry);
    return;
  }
  verify_pinned(run);
}

// The generic assertions every sweep iteration satisfies (8.2.3), followed by the repeat or the
// retry its observed outcome calls for. `own` lists records the schedule checks itself.
void verify(Run& run, const std::vector<std::string>& own, Retry retry = retry_plain, bsm_handle inherited = 0) {
  check(uncaught.empty() && !bsm_terminated(), "no uncaught exception");
  report_tracker(run);
  check(rejected.empty(), "the require path leaves the tracker empty");
  bsm_module_info root = info(run.root);
  if (run.kind == 0) {
    check(root.mapped && root.state == kFulfilled, "a fulfilled require leaves its root fulfilled");
  } else if (run.kind == -1) {
    check(!root.mapped || !root.linked, "a synchronous require failure stores no linked root");
    retry(run.root);
  } else {
    check(run.kind == 1, "the require settles inside its drain");
    verify_rejection(run, own, retry, inherited);
  }
  for (const auto& name : run.names) {
    check(contains(own, name) || body_runs(name) <= 1, "successful bodies run at most once");
  }
  check(rejected.empty() && uncaught.empty(), "verification leaves no report");
}

struct Sweep;
using Iteration = void (*)(Sweep&, size_t, bool);

struct Sweep {
  const char* label;
  std::vector<const char*> targets;
  Iteration iteration;
  int variant = 0;
  std::vector<bool> found;
  bool failed = false;
  std::unordered_map<std::string, unsigned> outcomes;
};

void tally(Sweep& sweep, const Run& run, const std::string& note = "") {
  if (run.kind == 1 || run.kind == -1) sweep.failed = true;
  std::string key = std::to_string(run.kind) + " " + run.outcome;
  if (!note.empty()) key += " " + note;
  ++sweep.outcomes[key];
}

void hit(Sweep& sweep, size_t target) { sweep.found.at(target) = true; }

bool complete(const Sweep& sweep) {
  for (bool found : sweep.found) {
    if (!found) return false;
  }
  return true;
}

// 8.2.3: a coarse pass finds the first depth with any refusal, then a 16-byte pass moves the
// refusal point through every position of the path until each required target was observed.
void run_sweep(Sweep& sweep) {
  sweep.found.assign(sweep.targets.size(), false);
  // The engine refuses below its 64 KiB reserve above __stack_low, so a depth that leaves 32 KiB
  // of real stack keeps the driver's own pre-engine code clear of the bottom.
  size_t room = stack_room();
  check(room > 256 * 1024, "the driver has stack room for a sweep");
  size_t limit = room - 32 * 1024;
  size_t first = kNoDepth;
  for (size_t depth = 0; depth <= limit && first == kNoDepth; depth += 4096) {
    sweep.failed = false;
    sweep.iteration(sweep, depth, true);
    if (sweep.failed) first = depth;
  }
  check(first != kNoDepth, "the sweep reaches a refusal");
  size_t start = first > 8192 ? first - 8192 : 0;
  size_t end = first + 131072 < limit ? first + 131072 : limit;
  for (size_t depth = start; depth <= end && !complete(sweep); depth += 16) {
    sweep.failed = false;
    sweep.iteration(sweep, depth, false);
  }
  printf("%s outcomes:", sweep.label);
  for (const auto& entry : sweep.outcomes) printf(" [%s] %u", entry.first.c_str(), entry.second);
  printf("\n");
  for (size_t i = 0; i < sweep.targets.size(); ++i) {
    if (!sweep.found[i]) fprintf(stderr, "%s missing required target: %s\n", sweep.label, sweep.targets[i]);
  }
  check(complete(sweep), "the sweep observed every required target");
  printf("%s required targets observed\n", sweep.label);
}

// S1: the stack-overflow shape, a root with no dependencies.
void s1_iteration(Sweep& sweep, size_t depth, bool coarse) {
  Run run;
  run.root = fresh("s1") + "-R";
  run.names = {run.root};
  counted_module(run.root, {}, "export const value = 42;");
  reset_reports();
  require_at(run, depth, coarse);
  tally(sweep, run);
  bool target = run.kind == 1 && run.outcome == "rolled back";
  verify(run, {});
  if (!target) return;
  check(body_runs(run.root) == 1, "S1 retry runs the root once");
  hit(sweep, 0);
}

// S2: a dependency refusal after a successful sibling. D sits one level below the sibling O, so
// a refusal at D can follow O's completed body.
void s2_iteration(Sweep& sweep, size_t depth, bool coarse) {
  std::string prefix = fresh("s2");
  Run run;
  std::string r = prefix + "-R", o = prefix + "-O", c = prefix + "-C", d = prefix + "-D";
  run.root = r;
  run.names = {r, o, c, d};
  counted_module(o, {}, "export const marker = {};");
  counted_module(d, {}, "export const value = 3;");
  counted_module(c, {d}, "export const value = 3;");
  counted_module(r, {o, c}, "export const value = 42;");
  reset_reports();
  require_at(run, depth, coarse);
  tally(sweep, run);
  bool target = run.kind == 1 && run.outcome == "rolled back" && !run.now(d).mapped &&
      run.now(o).mapped && run.now(o).state == kFulfilled && run.now(o).generation == run.before(o).generation;
  verify(run, {});
  if (!target) return;
  check(info(o).generation == run.before(o).generation && body_runs(o) == 1 && body_runs(d) == 1, "S2 sibling keeps its generation and runs once");
  hit(sweep, 0);
}

// S3 and S4: the cycle R <-> D after a successful sibling. D's body calls a native, whose entry
// check sits below D's own, so a refusal inside D's body (S4, D entered) and one before it (S3,
// nothing entered) are both reachable.
void s34_iteration(Sweep& sweep, size_t depth, bool coarse) {
  std::string prefix = fresh("s34");
  Run run;
  std::string r = prefix + "-R", o = prefix + "-O", d = prefix + "-D";
  run.root = r;
  run.names = {r, o, d};
  counted_module(o, {}, "export const marker = {};");
  counted_module(d, {r}, "Object.keys({}); export const value = 3;");
  counted_module(r, {o, d}, "export const value = 42;");
  reset_reports();
  require_at(run, depth, coarse);
  tally(sweep, run);
  bool s3 = run.kind == 1 && run.outcome == "rolled back" && !run.now(d).mapped && run.now(o).mapped &&
      run.now(o).generation == run.before(o).generation;
  bool s4 = run.kind == 1 && run.outcome == "pinned on body entry" && run.now(d).state == kFailed &&
      run.now(d).bodyEntered && run.now(r).state == kFailed && !run.now(r).bodyEntered;
  verify(run, {});
  if (s3) {
    check(body_runs(d) == 1 && body_runs(r) == 1 && body_runs(o) == 1, "S3 cycle rolled back and runs once on retry");
    hit(sweep, 0);
  }
  if (!s4) return;
  repeat_cached(d, run.value);
  check(body_runs(d) == 1 && body_runs(r) == 0, "S4 entered cycle stays cached and never reruns");
  hit(sweep, 1);
}

// S5: an SCC {A, B} with the external dependent E and the shared successful sibling O.
void s5_iteration(Sweep& sweep, size_t depth, bool coarse) {
  std::string prefix = fresh("s5");
  Run run;
  std::string r = prefix + "-R", o = prefix + "-O", e = prefix + "-E", a = prefix + "-A", b = prefix + "-B";
  run.root = r;
  run.names = {r, o, e, a, b};
  counted_module(o, {}, "export const marker = {};");
  counted_module(a, {b, o}, "export const a = 4;");
  counted_module(b, {a, o}, "export const b = 5;");
  counted_module(e, {a}, "export const value = 6;");
  counted_module(r, {o, e}, "export const value = 42;");
  reset_reports();
  require_at(run, depth, coarse);
  tally(sweep, run);
  bool target = run.kind == 1 && run.outcome == "rolled back" && !run.now(a).mapped && !run.now(b).mapped &&
      !run.now(e).mapped && run.now(o).mapped && run.now(o).generation == run.before(o).generation;
  verify(run, {});
  if (!target) return;
  check(info(o).generation == run.before(o).generation, "S5 the shared sibling keeps its generation");
  for (const auto& name : run.names) check(body_runs(name) == 1, "S5 every body runs once");
  hit(sweep, 0);
}

enum S6Variant { kNativeNatural, kNativeHeld, kLoweredNatural, kLoweredHeld, kNativeDrained, kNativeDrainedFail };

struct S6Graph {
  std::string p, d, r;
};

S6Graph s6_graph(const std::string& label, bool dependencyThrows) {
  std::string prefix = fresh(label);
  S6Graph graph{prefix + "-P", prefix + "-D", prefix + "-R"};
  counted_module(graph.d, {}, dependencyThrows ? "throw new Error('dependency body');" : "export const value = 3;");
  counted_module(graph.p, {graph.d}, "export const value = 1;");
  counted_module(graph.r, {graph.d}, "export const value = 2;");
  return graph;
}

void s6_check_setup(S6Variant variant, const S6Graph& graph, bsm_handle ip) {
  bsm_module_info p = info(graph.p), d = info(graph.d);
  if (variant == kLoweredNatural) {
    check(!p.mapped, "S6c P is not loaded before the require");
    return;
  }
  if (variant == kNativeDrained) {
    check(p.state == kFulfilled && d.state == kFulfilled && bsm_promise_state(ip) == 1, "S6e P and D fulfilled before the require");
    return;
  }
  if (variant == kNativeDrainedFail) {
    check(p.state == kFailed && d.state == kFailed && bsm_promise_state(ip) == 2, "S6e-fail P and D failed before the require");
    return;
  }
  bool linked = variant != kNativeNatural;
  check(p.mapped && p.state == kUnevaluated && p.linked == linked && p.importAcquired && !p.bodyEntered, "S6 P acquired and unevaluated");
  check(d.mapped && d.state == kUnevaluated && d.linked == linked, "S6 D unevaluated");
  if (ip) check(bsm_promise_state(ip) == 0, "S6 import pending");
}

bool s6_pinned_target(const Run& run, const S6Graph& graph, bool linked) {
  if (run.kind != 1 || run.outcome != "pinned on acquisition" || run.seen.before.empty()) return false;
  const auto& p = run.before(graph.p);
  const auto& d = run.now(graph.d);
  const auto& r = run.now(graph.r);
  if (d.state != kFailed || d.bodyEntered || !d.overRecursed || r.state != kFailed || r.bodyEntered) return false;
  check(p.mapped && p.state == kUnevaluated && p.linked == linked && p.importAcquired && !p.bodyEntered, "S6 observer sees P acquired before evaluation");
  check(run.before(graph.d).state == kUnevaluated && run.before(graph.d).linked && run.before(graph.r).linked, "S6 observer sees R and D linked");
  check(run.seen.edgesBefore.at(0).at(0) && run.seen.edgesBefore.at(0).at(1), "S6 edges P->D and R->D recorded");
  check(d.generation == run.before(graph.d).generation && r.generation == run.before(graph.r).generation, "S6 pinned records keep their generations");
  return true;
}

// The import side of S6: its promise settles consistently with P. Returns true when it rejected
// with `error` by identity, which is P inheriting D's cached failure. The continuation that
// evaluates P runs in the same deep drain, so P's own entry may also be refused there; that is
// the allowed outcome "P's own body refused", cached for P alone.
bool s6_import_side(const S6Graph& graph, bsm_handle promise, bsm_handle error) {
  int state = bsm_promise_state(promise);
  check(state == 1 || state == 2, "S6 import settles");
  bsm_module_info p = info(graph.p);
  if (state == 1) {
    check(p.state == kFulfilled && body_runs(graph.p) == 1, "S6 fulfilled import evaluated P once");
    return false;
  }
  Value reason(bsm_promise_result(promise));
  if (error && bsm_same_value(reason.handle, error)) {
    check(p.state == kFailed && !p.bodyEntered && body_runs(graph.p) == 0, "S6 P inherits the error without running");
    return true;
  }
  check(recursion_error(reason.handle), "S6 an import rejected otherwise carries an engine refusal");
  check(p.state == kFailed || !p.linked, "S6 rejected import is a P refusal or a refused handler");
  return false;
}

void s6_once(Sweep& sweep, size_t depth, bool coarse, bool isolate) {
  auto variant = static_cast<S6Variant>(sweep.variant);
  bool native = variant != kLoweredNatural && variant != kLoweredHeld;
  bool held = variant == kNativeHeld || variant == kLoweredHeld;
  S6Graph graph = s6_graph(sweep.label, variant == kNativeDrainedFail);
  reset_reports();
  bsm_release(hostImported);
  hostImported = 0;
  if (held) bsm_control_hold(native ? "dynamic-loaded" : "import-evaluate", graph.p.c_str());
  bsm_handle ip = native ? native_import_setup(graph.p) : 0;
  if (!native) schedule_host_import(graph.p);
  if (variant != kNativeNatural && variant != kLoweredNatural) jobs();
  bsm_control_hold("", "");
  if (held) check(bsm_control_held(graph.p.c_str()), "S6 hold parks P");
  s6_check_setup(variant, graph, native ? ip : hostImported);
  bsm_handle inherited = 0;
  if (variant == kNativeDrainedFail) inherited = bsm_promise_result(ip);
  reset_reports();
  Run run;
  run.root = graph.r;
  run.names = {graph.r, graph.d, graph.p};
  run.seen.edges = {{graph.p, graph.d}, {graph.r, graph.d}};
  require_at(run, depth, coarse, isolate ? 1 : -1);
  std::string note;
  if (ip && bsm_promise_state(ip) == 0 && !held) note = rejected.size() == 1 ? "Q4a/Q4b" : "Q4c";
  if (note == "Q4a/Q4b") {
    Value reason(bsm_promise_result(rejected[0]));
    check(recursion_error(reason.handle), "Q4 report carries the engine refusal");
    reset_reports();
  }
  if (!native && !hostImported) note = "hostImport refused";  tally(sweep, run, isolate ? note + "(require job only deep)" : note);
  bool pinned = note.empty() && s6_pinned_target(run, graph, variant != kNativeNatural && variant != kLoweredNatural);
  bool drained = variant == kNativeDrained && run.kind == 1 && run.outcome == "rolled back" &&
      run.now(graph.d).state == kFulfilled && run.now(graph.p).state == kFulfilled;
  bool boundary = variant == kNativeDrainedFail && run.kind == 1 && run.outcome == "pinned at a boundary" &&
      bsm_same_value(run.value, inherited);
  bsm_handle error = pinned ? bsm_dup(run.value) : 0;
  if (held && pinned) check(rejected.empty() && bsm_promise_state(native ? ip : hostImported) == 0, "S6 held import stays pending");
  verify(run, {graph.p}, retry_plain, inherited);
  if (held) {
    bsm_handle out = 0;
    check(bsm_control_resume(graph.p.c_str(), &out), "S6 resume P at shallow depth");
    jobs();
  }
  bool inheritedByP = false;
  if (note.empty() && variant != kNativeDrained && variant != kNativeDrainedFail) {
    inheritedByP = s6_import_side(graph, native ? ip : hostImported, error);
  }
  if (pinned && !inheritedByP && !native && !info(graph.p).linked) {
    // S6c/S6d: P's evaluation handler was refused at entry; a later shallow import inherits E.
    Value again(import(graph.p.c_str()));
    check(bsm_control_mark_handled(again.handle), "S6c later import handled");
    jobs();
    Value reason(bsm_promise_result(again.handle));
    check(bsm_same_value(reason.handle, error), "S6c a later import rejects with the require's error");
    inheritedByP = true;
  }
  if (pinned) repeat_cached(graph.d, error);
  if (pinned && !inheritedByP) ++sweep.outcomes["pinned on acquisition, then P refused in its own continuation"];
  if (pinned && inheritedByP) {
    repeat_cached(graph.p, error);
    check(body_runs(graph.d) == 0 && body_runs(graph.r) == 0 && body_runs(graph.p) == 0, "S6 pinned bodies never run");
    hit(sweep, 0);
  }
  if (drained) {
    check(info(graph.d).generation == run.before(graph.d).generation && info(graph.p).generation == run.before(graph.p).generation, "S6e D and P keep their generations");
    check(body_runs(graph.d) == 1 && body_runs(graph.p) == 1 && body_runs(graph.r) == 1, "S6e every body runs once");
    hit(sweep, 0);
  }
  if (boundary) {
    check(body_runs(graph.r) == 0, "S6e-fail R never runs");
    hit(sweep, 0);
  }
  bsm_release(error);
  bsm_release(inherited);
  bsm_release(ip);
  check(rejected.empty() && uncaught.empty(), "S6 iteration leaves no report");
}

// The natural orders run twice per depth: with the whole drain deep, which also reaches the Q4
// signatures and P's own refusal in its continuation, and with only the require's job deep
// (bsm_control_run_one_job), so the jobs around it run with room and the target's import side
// inherits D's error.
void s6_iteration(Sweep& sweep, size_t depth, bool coarse) {
  s6_once(sweep, depth, coarse, false);
  if (sweep.variant != kNativeNatural && sweep.variant != kLoweredNatural) return;
  bool failed = sweep.failed;
  s6_once(sweep, depth, coarse, true);
  sweep.failed = sweep.failed || failed;
}

// S6d-poisoned: the held lowered schedule at shallow depth with Promise.prototype.then,
// Promise.prototype.constructor and Promise[Symbol.species] replaced by counting throwing getters.
void s6d_poisoned() {
  S6Graph graph = s6_graph("s6d-poisoned", false);
  reset_reports();
  bsm_release(hostImported);
  hostImported = 0;
  std::string resolvedSource = "Promise.resolve(" + literal(graph.p) + ")";
  Value resolved(script(resolvedSource.c_str()));
  Value poison(script(
      "globalThis.poisonCounts = { then: 0, ctor: 0, species: 0 };"
      "globalThis.savedPromiseSlots = [Object.getOwnPropertyDescriptor(Promise.prototype, 'then'),"
      "  Object.getOwnPropertyDescriptor(Promise.prototype, 'constructor'),"
      "  Object.getOwnPropertyDescriptor(Promise, Symbol.species)];"
      "Object.defineProperty(Promise.prototype, 'then', { configurable: true, get() { poisonCounts.then++; throw new Error('poisoned then'); } });"
      "Object.defineProperty(Promise.prototype, 'constructor', { configurable: true, get() { poisonCounts.ctor++; throw new Error('poisoned constructor'); } });"
      "Object.defineProperty(Promise, Symbol.species, { configurable: true, get() { poisonCounts.species++; throw new Error('poisoned species'); } });"));
  bsm_control_hold("import-evaluate", graph.p.c_str());
  queue_host_import(resolved.handle);
  jobs();
  bsm_control_hold("", "");
  check(bsm_control_held(graph.p.c_str()), "S6d-poisoned parks P");
  RequireOutcome required = control_require(graph.r.c_str());
  check(required.kind == 0 && namespace_value(required.value) == 2, "S6d-poisoned bridge fulfilled with R's namespace");
  bsm_handle out = 0;
  check(bsm_control_resume(graph.p.c_str(), &out), "S6d-poisoned resume");
  jobs();
  check(hostImported && bsm_promise_state(hostImported) == 1, "S6d-poisoned hostImport fulfilled");
  Value ns(bsm_promise_result(hostImported));
  check(namespace_value(ns.handle) == 1, "S6d-poisoned hostImport carries P's namespace");
  Value restore(script(
      "Object.defineProperty(Promise.prototype, 'then', savedPromiseSlots[0]);"
      "Object.defineProperty(Promise.prototype, 'constructor', savedPromiseSlots[1]);"
      "Object.defineProperty(Promise, Symbol.species, savedPromiseSlots[2]);"
      "poisonCounts.then + poisonCounts.ctor + poisonCounts.species"));
  check(bsm_number(restore.handle) == 0, "S6d-poisoned reads no public Promise slot");
  check(rejected.empty() && uncaught.empty(), "S6d-poisoned leaves no report");
  puts("S6d-poisoned passed");
}

// S7: a successful dependency's body imports a record later in the same graph, which refuses.
// Only the require's job runs deep; the import's own continuation jobs run shallow afterwards,
// so the pre-existing Q4 refusals of that continuation stay out of this schedule.
void s7_iteration(Sweep& sweep, size_t depth, bool coarse) {
  std::string prefix = fresh("s7");
  Run run;
  std::string r = prefix + "-R", o = prefix + "-O", c = prefix + "-C", e = prefix + "-E";
  run.root = r;
  run.names = {r, o, c, e};
  counted_module(e, {}, "export const value = 5;");
  counted_module(c, {e}, "export const value = 5;");
  // O keeps its import promise for the driver, which owns it as the caller would; a `.catch`
  // call in O's body could itself be refused and leave the promise unhandled by user code.
  std::string kept = "globalThis.recoveryImports[" + literal(o) + "]";
  counted_module(o, {}, kept + " = import(" + literal(e) + "); export const value = 1;");
  counted_module(r, {o, c}, "export const value = 42;");
  reset_reports();
  require_at(run, depth, coarse, 0);
  Value imported(script(kept.c_str()));
  if (bsm_promise_state(imported.handle) >= 0) check(bsm_control_mark_handled(imported.handle), "S7 import owned by the driver");
  tally(sweep, run);
  bool target = run.kind == 1 && run.outcome == "pinned on acquisition" && run.now(e).state == kFailed &&
      !run.now(e).bodyEntered && !run.seen.after.empty() && run.seen.after.back().at(run.at(e)).importAcquired;
  verify(run, {});
  if (!target) return;
  repeat_cached(e, run.value);
  check(body_runs(e) == 0 && body_runs(o) == 1, "S7 acquired record stays cached");
  hit(sweep, 0);
}

// S8: an earlier pinned refusal of D, then a fresh R that imports D pins at the boundary.
void s8_iteration(Sweep& sweep, size_t depth, bool coarse) {
  std::string prefix = fresh("s8");
  std::string p = prefix + "-P", d = prefix + "-D", r = prefix + "-R";
  counted_module(d, {}, "export const value = 3;");
  counted_module(p, {d}, "export const value = 1;");
  reset_reports();
  bsm_control_hold("dynamic-loaded", p.c_str());
  bsm_handle ip = native_import_setup(p);
  jobs();
  bsm_control_hold("", "");
  check(bsm_control_held(p.c_str()), "S8 hold parks P");
  Run run;
  run.root = d;
  run.names = {d, p};
  require_at(run, depth, coarse);
  tally(sweep, run);
  bool target = run.kind == 1 && run.outcome == "pinned on acquisition" && !run.now(d).bodyEntered;
  verify(run, {p});
  if (target) {
    counted_module(r, {d}, "export const value = 2;");
    RequireOutcome inherited = control_require(r.c_str());
    check(inherited.kind == 1 && bsm_same_value(inherited.value, run.value) &&
        !strcmp(bsm_control_last_outcome(), "pinned at a boundary"), "S8 fresh importer pins at the boundary with D's error");
    repeat_cached(r, run.value);
    check(body_runs(r) == 0, "S8 importer never runs");
    hit(sweep, 0);
  }
  bsm_handle out = 0;
  check(bsm_control_resume(p.c_str(), &out), "S8 resume P");
  jobs();
  S6Graph graph{p, d, r};
  s6_import_side(graph, ip, target ? run.value : 0);
  bsm_release(ip);
}

// S9: a top-level-await dependency is still pending when a later synchronous dependency refuses.
void s9_iteration(Sweep& sweep, size_t depth, bool coarse) {
  std::string prefix = fresh("s9");
  Run run;
  std::string r = prefix + "-R", t = prefix + "-T", c = prefix + "-C", s = prefix + "-S";
  run.root = r;
  run.names = {r, t, c, s};
  pendingName = t;
  counted_module(t, {}, awaiting(t));
  counted_module(s, {}, "export const value = 3;");
  counted_module(c, {s}, "export const value = 3;");
  counted_module(r, {t, c}, "export const value = 42;");
  reset_reports();
  require_at(run, depth, coarse);
  tally(sweep, run);
  if (run.kind == 2) {
    check(rejected.empty() && uncaught.empty(), "S9 pending require leaves no report");
    resolve_pending(t);
    check(info(r).state == kFulfilled && body_runs(t) == 1 && body_runs(r) == 1, "S9 resolution completes the graph once");
    return;
  }
  bool target = run.kind == 1 && run.outcome == "pinned on a pending candidate" && run.now(t).state == kPending;
  verify(run, {}, retry_after_pending);
  resolve_pending(t);
  if (!target) return;
  check(info(t).state == kFulfilled && info(r).state == kFailed && body_runs(t) == 1 && body_runs(r) == 0, "S9 no stale record and no duplicate side effect");
  repeat_cached(r, run.value);
  hit(sweep, 0);
}

// S10: require-owned pending evaluations that reject inside the drain or after it.
void s10_cases() {
  std::string ordinary = fresh("s10-ordinary");
  counted_module(ordinary, {}, "await 0; throw new Error('s10 ordinary');");
  reset_reports();
  RequireOutcome first = control_require(ordinary.c_str());
  {
    RequirePromises promises;
    check(first.kind == 1 && bsm_promise_state(promises.evaluation) == 2 && bsm_promise_state(promises.bridge) == 2, "S10 ordinary rejection reaches the bridge");
  }
  install("s10Error", first.value);
  Value message(script("s10Error instanceof Error && s10Error.message === 's10 ordinary'"));
  check(bsm_bool_value(message.handle) && rejected.empty() && uncaught.empty(), "S10 original reason, nothing reported");
  repeat_cached(ordinary, first.value);

  std::string resource = fresh("s10-resource");
  counted_module(resource, {}, "await 0; function recurse() { return recurse() + 1; } recurse();");
  RequireOutcome overflow = control_require(resource.c_str());
  check(overflow.kind == 1 && recursion_error(overflow.value) && info(resource).bodyEntered, "S10 resource error after await is a body failure");
  repeat_cached(resource, overflow.value);
  check(body_runs(resource) == 1, "S10 body runs once");

  const char* reasons[] = {"new Error('late')", "(() => { try { (function f() { f(); })(); } catch (error) { return error; } })()"};
  for (const char* reason : reasons) {
    std::string late = fresh("s10-late");
    std::string key = "globalThis.recoveryRejecters[" + literal(late) + "]";
    counted_module(late, {}, "await new Promise((_, reject) => { " + key + " = reject; }); export const value = 1;");
    RequireOutcome pending = control_require(late.c_str());
    check(pending.kind == 2 && rejected.empty(), "S10 pending beyond the drain gives the async TypeError");
    std::string source = "globalThis.lateReason = " + std::string(reason) + "; " + key + "(lateReason);";
    Value settle(script(source.c_str()));
    jobs();
    check(rejected.empty() && uncaught.empty(), "S10 later rejection stays owned");
    Value lateReason(global_value_handle("lateReason"));
    RequireOutcome cached = control_require(late.c_str());
    check(cached.kind == 1 && bsm_same_value(cached.value, lateReason.handle), "S10 later rejection is cached");
  }
  puts("S10 passed");
}

// S10b: a require-owned pending evaluation that finishes inside the drain; the target is the
// namespace handler refused at entry.
void s10b_iteration(Sweep& sweep, size_t depth, bool coarse) {
  Run run;
  run.root = fresh("s10b") + "-N";
  run.names = {run.root};
  counted_module(run.root, {}, "await 0; export const value = 7;");
  reset_reports();
  // Every other iteration runs require_loaded and the await continuation shallow, so only the
  // namespace job runs deep; it enters at the same depth as require_loaded, which would
  // otherwise be refused first.
  bool isolate = sweep.variant++ % 2;
  require_at(run, depth, coarse, isolate ? kAfterEvaluation : -1);
  tally(sweep, run, isolate ? "(namespace job only deep)" : "");
  bool target = false;
  if (run.kind == 1 && run.outcome == "no failure" && run.now(run.root).state == kFulfilled) {
    RequirePromises promises;
    target = promises.derived && bsm_promise_state(promises.derived) == 2 && bsm_promise_state(promises.bridge) == 2;
  }
  verify(run, {});
  if (!target) return;
  RequireOutcome repeat = control_require(run.root.c_str());
  check(repeat.kind == 0 && namespace_value(repeat.value) == 7 && body_runs(run.root) == 1, "S10b shallow repeat returns the namespace");
  hit(sweep, 0);
}

// S11: an import-owned pending evaluation joined by a require.
void s11_iteration(Sweep& sweep, size_t depth, bool coarse) {
  std::string prefix = fresh("s11");
  std::string t = prefix + "-T", r = prefix + "-R";
  pendingName = t;
  counted_module(t, {}, awaiting(t));
  counted_module(r, {t}, "export const value = 2;");
  reset_reports();
  Value imported(import(t.c_str()));
  check(bsm_control_mark_handled(imported.handle), "S11 import caller owns its promise");
  jobs();
  check(info(t).state == kPending, "S11 import evaluation pending");
  Run run;
  run.root = r;
  run.names = {r, t};
  require_at(run, depth, coarse);
  tally(sweep, run);
  if (run.kind == 2) {
    check(run.outcome == "pinned at a boundary" && rejected.empty(), "S11 require pins at the boundary");
    resolve_pending(t);
    check(bsm_promise_state(imported.handle) == 1 && info(r).state == kFulfilled, "S11 import and require complete");
    RequireOutcome done = control_require(r.c_str());
    check(done.kind == 0 && body_runs(r) == 1 && body_runs(t) == 1, "S11 every body runs once");
    hit(sweep, 0);
    return;
  }
  verify(run, {t}, retry_after_pending);
  resolve_pending(t);
  check(bsm_promise_state(imported.handle) == 1 && body_runs(t) == 1, "S11 import completes once");
}

// S12 and S13: a nested require from a module body, overlapping the outer graph or disjoint.
void nested_iteration(Sweep& sweep, size_t depth, bool coarse) {
  bool overlap = sweep.variant == 0;
  std::string prefix = fresh(overlap ? "s12" : "s13");
  std::string r = prefix + "-R", m = prefix + "-M", n = prefix + "-N";
  std::string caught = "globalThis.recoveryCaught[" + literal(m) + "]";
  counted_module(n, {}, "export const value = 3;");
  counted_module(m, {}, "try { hostRequire(" + literal(n) + "); } catch (error) { " + caught + " = error; } export const value = 1;");
  counted_module(r, overlap ? std::vector<std::string>{m, n} : std::vector<std::string>{m}, "export const value = 42;");
  hostRequireFailures = 0;
  reset_reports();
  // Compile N shallow: inside M's deep body the parser would refuse before N's evaluation can.
  if (!overlap) check(bsm_control_load(n.c_str()), "S13 preload N");
  Run run;
  run.root = r;
  run.names = {r, m, n};
  require_at(run, depth, coarse);
  if (hostRequireFailures) sweep.failed = true;
  std::string note = "nested";
  for (size_t i = 0; i + 1 < run.seen.outcomes.size(); ++i) note += " [" + run.seen.outcomes[i] + "]";
  tally(sweep, run, note);
  bool nestedPinned = run.seen.outcomes.size() == 2 && run.seen.outcomes[0] == "pinned on a pending importer";
  bool nestedRolled = run.seen.outcomes.size() == 2 && run.seen.outcomes[0] == "rolled back";
  bool s12 = overlap && nestedPinned && run.kind == 1 && run.outcome == "rolled back" && !run.now(n).mapped &&
      run.now(m).state == kFulfilled;
  bool s13 = !overlap && nestedRolled && run.kind == 0 && !run.now(n).mapped;
  if (s12) {
    Value thrown(script(caught.c_str()));
    check(bsm_same_value(thrown.handle, run.value), "S12 outer rejection is the nested refusal");
  }
  verify(run, overlap ? std::vector<std::string>{} : std::vector<std::string>{n});
  if (s12) {
    check(info(m).generation == run.before(m).generation && body_runs(m) == 1 && body_runs(n) == 1 && body_runs(r) == 1, "S12 outer rollback keeps M and reruns nothing");
    hit(sweep, 0);
  }
  if (!s13) return;
  uint64_t generation = run.before(n).generation;
  RequireOutcome retry = control_require(n.c_str());
  check(retry.kind == 0 && info(n).generation > generation && body_runs(n) == 1, "S13 nested graph rolled back independently");
  hit(sweep, 0);
}

// One fixture graph shape (8.1.4): returns its modules, writing their sources under `prefix`.
std::vector<std::string> js_depth_graph(const std::string& prefix, const std::string& shape) {
  std::string ok = prefix + "-ok", leaf = prefix + "-leaf", deep = prefix + "-deep";
  std::string a = prefix + "-a", b = prefix + "-b", root = prefix + "-root";
  bool sibling = shape == "sibling" || shape == "combined";
  bool chain = shape == "chain" || sibling;
  bool cycle = shape == "cycle" || shape == "combined";
  std::vector<std::string> deps, graph = {root};
  if (sibling) deps.push_back(ok);
  if (chain) deps.push_back(deep);
  if (cycle) deps.push_back(a);
  if (sibling) graph.push_back(ok);
  if (chain) graph.insert(graph.end(), {deep, leaf});
  if (cycle) graph.insert(graph.end(), {a, b});
  counted_module(ok, {}, "export const marker = {};");
  counted_module(leaf, {}, "export const value = 3;");
  counted_module(deep, {leaf}, "export const value = 3;");
  counted_module(a, {b}, "export const a = 4;");
  counted_module(b, {a}, "export const b = 5;");
  counted_module(root, deps, "export const value = 42;");
  return graph;
}

void js_depth_shape(const std::string& shape, bool every) {
  std::string prefix = fresh(std::string("js-") + (every ? "every-" : "single-") + shape);
  std::vector<std::string> graph = js_depth_graph(prefix, shape);
  const std::string& root = graph[0];
  reset_reports();
  std::string call = "recoveryLimit(" + literal(root) + ", " + (every ? "true" : "false") + ")";
  Value failures(script(call.c_str()));
  jobs();
  check(rejected.empty() && uncaught.empty(), "JS-depth require leaves no report");
  RequireOutcome shallow = control_require(root.c_str());
  check(shallow.kind == 0 && namespace_value(shallow.value) == 42, "JS-depth schedule recovers");
  if (every) {
    Value recovered(global_value_handle("recoveredNamespace"));
    check(bsm_same_value(recovered.handle, shallow.value), "every-level recovery returns the cached namespace");
  }
  for (const auto& module : graph) check(body_runs(module) == 1, "JS-depth schedule runs each body once");
  printf("JS-depth %s %s recovered after %d refusals, each body once\n", every ? "every-level" : "single", shape.c_str(),
         static_cast<int>(bsm_number(failures.handle)));
}

// The JavaScript-depth form (8.2.1): recursion in JavaScript, then hostRequire at the deepest
// catch only or at every unwind level until it succeeds. The every-level schedule is an accepted
// departure from native Bun, which caches the RangeError there; SpiderMonkey recovers and every
// body runs once (spidermonkey-design/UNIT3-NATIVE-SCOPE.md).
void js_depth_schedules() {
  Value helper(script(
      "globalThis.recoveryLimit = function (path, every) {"
      "  let failures = 0, done = false, attempted = false;"
      "  function recurse() {"
      "    try { recurse(); } catch (error) { if (!(error instanceof RangeError)) throw error; }"
      "    if (done || (!every && attempted)) return;"
      "    attempted = true;"
      "    try { globalThis.recoveredNamespace = hostRequire(path); done = true; }"
      "    catch (error) { if (!(error instanceof RangeError)) throw error; failures++; }"
      "  }"
      "  recurse();"
      "  return failures;"
      "};"));
  const std::string shapes[] = {"plain", "chain", "sibling", "cycle", "combined"};
  for (const auto& shape : shapes) js_depth_shape(shape, false);
  for (const auto& shape : shapes) js_depth_shape(shape, true);
}

// The JavaScript-depth sweep (8.2.1): recursion in JavaScript down `frames` levels, then
// hostRequire at the bottom. The JavaScript frames fill PBL's auxiliary stack or the
// interpreter's frame stack rather than the native stack, so this reaches the refusal points the
// native sweep cannot. `frames` walks down from just past the deepest level until a rollback is
// observed.
void js_depth_once(Sweep& sweep, int frames) {
  std::string prefix = fresh("js-sweep");
  Run run;
  std::string o = prefix + "-O", d = prefix + "-D";
  run.root = prefix + "-R";
  run.names = {run.root, o, d};
  counted_module(o, {}, "export const marker = {};");
  counted_module(d, {}, "export const value = 3;");
  counted_module(run.root, {o, d}, "export const value = 42;");
  reset_reports();
  run.seen.names = run.names;
  observing = &run.seen;
  bsm_control_observe(observe);
  unsigned calls = hostRequireCalls;
  std::string call = "recoveryAt(" + std::to_string(frames) + ", " + literal(run.root) + ")";
  Value result(script(call.c_str()));
  run.outcome = hostRequireCalls == calls ? "host call refused" : bsm_control_last_outcome();
  bsm_control_observe(nullptr);
  observing = nullptr;
  drain_observed();
  bsm_handle tooDeep = 0, error = 0;
  check(bsm_get(result.handle, "tooDeep", 7, &tooDeep) && bsm_get(result.handle, "error", 5, &error), "JS-depth result");
  Value ownedTooDeep(tooDeep), ownedError(error);
  run.start = infos(run.names);
  if (bsm_kind(tooDeep) != 0) {
    ++sweep.outcomes["recursion refused before the require"];
    return;
  }
  run.kind = bsm_kind(error) == 0 ? 0 : 1;
  if (run.kind) run.value = bsm_dup(error);
  if (run.outcome == "host call refused") {
    ++sweep.outcomes[run.outcome];
    check(!info(run.root).mapped && recursion_error(error), "a refused hostRequire never reaches the adapter");
    return;
  }
  tally(sweep, run);
  bool target = run.kind == 1 && run.outcome == "rolled back";
  verify(run, {});
  if (!target) return;
  check(body_runs(o) == 1 && body_runs(d) == 1 && body_runs(run.root) == 1, "JS-depth rollback runs each body once");
  hit(sweep, 0);
}

void js_depth_sweep() {
  Value helpers(script(
      "globalThis.recoveryAt = function (frames, path) {"
      "  function down(n) {"
      "    if (n > 0) return down(n - 1);"
      "    try { return { tooDeep: undefined, error: undefined, ns: hostRequire(path) }; }"
      "    catch (error) { if (!(error instanceof RangeError)) throw error; return { tooDeep: undefined, error }; }"
      "  }"
      "  try { return down(frames); }"
      "  catch (error) { if (!(error instanceof RangeError)) throw error; return { tooDeep: true, error: undefined }; }"
      "};"
      "globalThis.recoveryDepth = function () {"
      "  function probe(n) { try { return probe(n + 1); } catch (error) { return n; } }"
      "  return probe(0);"
      "};"));
  Value depth(script("recoveryDepth()"));
  int deepest = static_cast<int>(bsm_number(depth.handle));
  Sweep sweep{"JS-depth sweep", {"rolled back"}, nullptr};
  sweep.found.assign(1, false);
  for (int frames = deepest + 64; frames >= 0 && frames >= deepest - 8192 && !complete(sweep); --frames) {
    js_depth_once(sweep, frames);
  }
  printf("%s from %d frames, outcomes:", sweep.label, deepest);
  for (const auto& entry : sweep.outcomes) printf(" [%s] %u", entry.first.c_str(), entry.second);
  printf("\n");
  check(complete(sweep), "the JavaScript-depth sweep observed a rollback");
  printf("%s required targets observed\n", sweep.label);
}

// F13-F15 (8.3, Unit 3 rows). F16 is the separate recovery-map-trap death test.
void unit3_faults() {
  std::string prefix = fresh("f13");
  std::string r = prefix + "-R", d = prefix + "-D";
  counted_module(d, {}, "export const value = 3;");
  counted_module(r, {d}, "export const value = 2;");
  reset_reports();
  arm_fault("requireLoaded:snapshot-append");
  RequireOutcome f13 = control_require(r.c_str());
  check(f13.kind == 0 && !strcmp(bsm_control_last_outcome(), "pinned on snapshot OOM") && rejected.empty() && uncaught.empty(), "F13 snapshot OOM pins and evaluation proceeds");
  clear_fault();

  for (uint32_t nth = 1; nth <= 2; ++nth) {
    prefix = fresh("f14");
    r = prefix + "-R";
    d = prefix + "-D";
    counted_module(d, {}, "export const value = 3;");
    counted_module(r, {d}, "export const value = 2;");
    reset_reports();
    arm_fault("requireSetup:edge-reserve", nth);
    RequireOutcome f14 = control_require(r.c_str());
    check(f14.kind == 1 && rejected.empty() && rejectionEvents.size() == 2 && !rejectionEvents[0] && rejectionEvents[1], "F14 loading rejection is handled");
    install("oomProbe", f14.value);
    Value oom(script("oomProbe === 'out of memory'"));
    check(bsm_bool_value(oom.handle), "F14 bridge carries the reserve OOM");
    check(!bsm_control_edge(r.c_str(), d.c_str()) && info(r).imports == 0 && info(d).importers == 0, "F14 neither edge direction");
    clear_fault();
    reset_reports();
    RequireOutcome retry = control_require(r.c_str());
    check(retry.kind == 0 && bsm_control_edge(r.c_str(), d.c_str()) && info(r).imports == 1 && info(d).importers == 1, "F14 retry reloads and records both edges once");
  }

  std::string f15 = fresh("f15");
  counted_module(f15, {}, "export const value = 1;");
  reset_reports();
  arm_fault("requireSetup:entry-allocation");
  RequireOutcome failed = control_require(f15.c_str());
  check(failed.kind == -1 && !info(f15).mapped && rejected.empty() && uncaught.empty(), "F15 entry allocation fails the compile and inserts nothing");
  check_repeat(f15.c_str());
  puts("F13-F15 passed");
}

// Holder mark of a pending dynamic import (5.1). The adapter's name lookup allocates; a failed
// lookup while a dynamic import loads its module must neither drop the import's acquisition mark
// nor leave an exception pending behind a successful hook. Found by the PR 751 review.
void holder_lookup_fault() {
  S6Graph graph = s6_graph("holder-lookup", false);
  reset_reports();
  arm_fault("*:holder-lookup");
  bsm_handle ip = native_import_setup(graph.p);
  bool pendingException = JS_IsExceptionPending(context);
  clear_fault();
  bsm_module_info p = info(graph.p);
  int state = bsm_promise_state(ip);
  printf("holder lookup: acquired=%d import-state=%d pending-exception=%d\n", p.importAcquired, state, pendingException);
  check(!pendingException, "a holder lookup failure leaves no pending exception");
  check(p.mapped && p.importAcquired && state == 0, "a pending dynamic import keeps its acquisition mark");
  jobs();
  check(bsm_promise_state(ip) == 1 && info(graph.p).state == kFulfilled && rejected.empty(), "the import then completes");
  bsm_release(ip);
  puts("holder lookup control passed");
}

void recovery_globals() {
  Value initialize(script("globalThis.recoveryRuns = {}; globalThis.recoveryResolvers = {}; globalThis.recoveryRejecters = {}; globalThis.recoveryCaught = {}; globalThis.recoveryImports = {}; globalThis.recoveryGates = {};"));
  hostImportFunction = bsm_function("hostImport", 10, 200);
  hostRequireFunction = bsm_function("hostRequire", 11, 201);
  install("hostImport", hostImportFunction);
  install("hostRequire", hostRequireFunction);
}

void recovery_release() {
  bsm_release(hostImported);
  bsm_release(hostImportFunction);
  bsm_release(hostRequireFunction);
  hostImported = hostImportFunction = hostRequireFunction = 0;
}

void recovery_controls() {
  setvbuf(stdout, nullptr, _IONBF, 0);
  recovery_globals();
  unit3_faults();
  holder_lookup_fault();
  s10_cases();
  s6d_poisoned();
  Sweep sweeps[] = {
      {"S1", {"rolled back"}, s1_iteration},
      {"S2", {"rolled back after a successful sibling"}, s2_iteration},
      {"S3/S4", {"S3 rolled back before any member entered", "S4 pinned on body entry"}, s34_iteration},
      {"S5", {"rolled back with the shared sibling kept"}, s5_iteration},
      {"S6a", {"pinned on acquisition"}, s6_iteration, kNativeNatural},
      {"S6b", {"pinned on acquisition"}, s6_iteration, kNativeHeld},
      {"S6c", {"pinned on acquisition"}, s6_iteration, kLoweredNatural},
      {"S6d", {"pinned on acquisition"}, s6_iteration, kLoweredHeld},
      {"S6e", {"rolled back, R only"}, s6_iteration, kNativeDrained},
      {"S6e-fail", {"pinned at a boundary with D's error"}, s6_iteration, kNativeDrainedFail},
      {"S7", {"pinned on acquisition"}, s7_iteration},
      {"S8", {"pinned on acquisition, then pinned at a boundary"}, s8_iteration},
      {"S9", {"pinned on a pending candidate"}, s9_iteration},
      {"S10b", {"namespace handler refused at entry"}, s10b_iteration},
      {"S11", {"pinned at a boundary"}, s11_iteration},
      {"S12", {"nested pins, outer rolls back"}, nested_iteration, 0},
      {"S13", {"nested rolled back independently"}, nested_iteration, 1},
  };
  for (auto& sweep : sweeps) run_sweep(sweep);
  js_depth_sweep();
  js_depth_schedules();
  recovery_release();
}

// S14: termination during a body, then shutdown with a require handler still queued.
void recovery_termination() {
  recovery_globals();
  std::string loop = fresh("s14-loop"), queued = fresh("s14-queued");
  counted_module(loop, {}, "while (true) {} export const value = 1;");
  counted_module(queued, {}, "export const value = 2;");
  reset_reports();
  bsm_handle loopBridge = 0, queuedBridge = 0;
  check(bsm_require(loop.data(), loop.size(), &loopBridge), "S14 require setup");
  check(bsm_require(queued.data(), queued.size(), &queuedBridge), "S14 queued require setup");
  interruptAt = interruptCalls + 1;
  drain_observed();
  check(bsm_terminated(), "S14 termination latched");
  std::string outcome = bsm_control_last_outcome();
  printf("S14 outcome %s\n", outcome.c_str());
  check(outcome == "pinned on body entry" || outcome == "pinned because evaluation returned false", "S14 a terminated body is never rolled back");
  check(bsm_promise_state(loopBridge) == 0 && bsm_promise_state(queuedBridge) == 0, "S14 bridges stay pending");
  check(rejected.empty() && uncaught.empty(), "S14 nothing reported");
  size_t retired = 0;
  uint32_t active = 0;
  bsm_control_retirement(&retired, &active);
  check(!retired && !active, "S14 no retirement outstanding");
  bsm_release(loopBridge);
  bsm_release(queuedBridge);
  recovery_release();
}

// F16: map insertion keeps the adapter's trap-on-exhaustion policy (6.6).
void recovery_map_trap() {
  std::string name = fresh("f16");
  counted_module(name, {}, "export const value = 1;");
  arm_fault("requireSetup:map-insertion");
  RequireOutcome trapped = control_require(name.c_str());
  fprintf(stderr, "F16 map insertion returned kind %d instead of trapping\n", trapped.kind);
}
