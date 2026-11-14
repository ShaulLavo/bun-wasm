struct RecoverySweep {
  unsigned schedule;
  size_t serial = 0;
  std::string prefix, root, dependency, importer, sibling;
  std::vector<std::string> names;
  std::vector<bsm_module_info> before, after;
  std::string outcome;
  bsm_handle bridge = 0, ip = 0, error = 0;
  bool failed = false, target = false;
  bool held = false, native = false;
};

RecoverySweep* observingRecovery = nullptr;

bsm_module_info module_info(const std::string& name) {
  bsm_module_info info;
  bsm_control_module_info(name.c_str(), &info);
  return info;
}

void recovery_observer(const char* point) {
  auto& state = *observingRecovery;
  bool before = !strcmp(point, "require-before-evaluate");
  if (!before && strcmp(point, "require-after-evaluate")) return;
  auto& list = before ? state.before : state.after;
  list.clear();
  for (const auto& name : state.names) list.push_back(module_info(name));
  if (!before) state.outcome = bsm_control_last_outcome();
}

std::string counted(const std::string& name, const std::string& body) {
  return "globalThis.recoveryRuns['" + name + "'] = (globalThis.recoveryRuns['" + name + "'] || 0) + 1; " + body;
}

void recovery_graph(RecoverySweep& state) {
  state.prefix = "s" + std::to_string(state.schedule) + "-" + std::to_string(state.serial++);
  state.root = state.prefix + "-R";
  state.dependency = state.prefix + "-D";
  state.importer = state.prefix + "-P";
  state.sibling = state.prefix + "-O";
  state.names = {state.root, state.dependency, state.importer, state.sibling};
  sources[state.root] = counted(state.root, "export const answer = 42;");
  sources[state.dependency] = counted(state.dependency, "export const answer = 42;");
  sources[state.sibling] = counted(state.sibling, "export const marker = {};");
  if (state.schedule == 1) return;
  sources[state.root] = "import '" + state.sibling + "'; import '" + state.dependency + "'; " + sources[state.root];
  if (state.schedule >= 3 && state.schedule <= 5) {
    sources[state.dependency] = "import '" + state.root + "'; " + sources[state.dependency];
  }
  sources[state.importer] = "import '" + state.dependency + "'; " + counted(state.importer, "export const answer = 42;");
}

void recovery_drain(void* opaque) {
  auto& state = *static_cast<RecoverySweep*>(opaque);
  RequireOutcome result = control_require_promise(state.bridge);
  state.failed = result.kind != 0;
  bsm_release(state.error);
  state.error = result.kind == 1 ? bsm_dup(result.value) : 0;
  RequirePromises promises;
  check(promises.loading && bsm_promise_state(promises.loading) == 1, "recovery loading fulfilled");
  check(promises.bridge && bsm_promise_state(promises.bridge) == (result.kind == 0 ? 1 : 2), "recovery actual bridge state");
  check(rejected.empty() && uncaught.empty(), "recovery generic ownership");
}

void recovery_repeat(const std::string& name, bsm_handle expected, bool failed) {
  RequireOutcome result = control_require(name.c_str());
  check(result.kind == (failed ? 1 : 0), "recovery repeat kind");
  if (expected) check(bsm_same_value(result.value, expected), "recovery repeat identity");
  auto generation = module_info(name).generation;
  Value imported(import(name.c_str()));
  check(bsm_control_mark_handled(imported.handle), "recovery import caller owns rejection");
  jobs();
  check(bsm_promise_state(imported.handle) == (failed ? 2 : 1), "recovery import state");
  Value importResult(bsm_promise_result(imported.handle));
  check(bsm_same_value(result.value, importResult.handle), "recovery import identity");
  std::string nativeName = name + "-native-repeat";
  sources[nativeName] = "export default import('" + name + "');";
  Value nativeImport(import(nativeName.c_str()));
  jobs();
  Value ns(bsm_promise_result(nativeImport.handle));
  bsm_handle nested = 0;
  check(bsm_get(ns.handle, "default", 7, &nested), "recovery native import promise");
  Value nestedPromise(nested);
  check(bsm_control_mark_handled(nested), "recovery native import owned");
  jobs();
  Value nativeResult(bsm_promise_result(nested));
  check(bsm_promise_state(nested) == (failed ? 2 : 1) && bsm_same_value(result.value, nativeResult.handle), "recovery native import identity");
  check(module_info(name).generation == generation, "recovery repeat generation stable");
}

bool recovery_target(RecoverySweep& state) {
  if (state.outcome != "rolled back") return false;
  bool rootRetired = !state.after.empty() && state.after[0].retired;
  if (!rootRetired) return false;
  if (state.schedule == 1) return true;
  return state.after[1].retired && state.after[3].state == 2;
}

void recovery_iteration(RecoverySweep& state, size_t depth, bool coarse) {
  recovery_graph(state);
  state.before.clear();
  state.after.clear();
  state.outcome = "not entered";
  state.failed = false;
  reset_reports();
  observingRecovery = &state;
  bsm_control_observe(recovery_observer);
  check(bsm_require(state.root.c_str(), state.root.size(), &state.bridge), "recovery shallow require setup");
  if (coarse) at_native_depth_coarse(depth, recovery_drain, &state);
  else at_native_depth(depth, recovery_drain, &state);
  bsm_control_observe(nullptr);
  size_t retired = 0;
  uint32_t active = 0;
  bsm_control_retirement(&retired, &active);
  check(!retired && !active, "recovery deferred entries freed outside snapshots");
  if (!recovery_target(state)) return;
  state.target = true;
  check_range_error(state.error);
  auto generation = state.before[0].generation;
  recovery_repeat(state.root, 0, false);
  check(module_info(state.root).generation > generation, "recovery retry compiles a new generation");
  if (state.schedule == 1) return;
}

void recovery_sweep(unsigned schedule) {
  RecoverySweep state{schedule};
  size_t firstFailure = 0;
  for (size_t depth = 0; depth <= 8 * 1024 * 1024; depth += 4096) {
    recovery_iteration(state, depth, true);
    if (!state.failed) continue;
    firstFailure = depth;
    break;
  }
  check(firstFailure, "recovery coarse refusal");
  size_t start = firstFailure > 8192 ? firstFailure - 8192 : 0;
  for (size_t depth = start; depth < firstFailure + 4096 && !state.target; depth += 16) {
    recovery_iteration(state, depth, false);
  }
  if (!state.target) fprintf(stderr, "S%u last outcome %s\n", schedule, state.outcome.c_str());
  check(state.target, "recovery required target observed");
  printf("S%u rollback target observed\n", schedule);
}
