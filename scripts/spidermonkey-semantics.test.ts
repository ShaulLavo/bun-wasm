import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const shim = readFileSync("crates/bunwasm-spidermonkey/cpp/engine.cpp", "utf8");
const adapter = readFileSync("crates/bunwasm-engine-spidermonkey/src/vm.rs", "utf8");

function definition(source: string, signature: string): string {
  const start = source.indexOf(signature);
  if (start < 0) throw new Error(`Missing ${signature}`);
  const body = source.indexOf("{", start);
  let depth = 1;
  let end = body;
  while (depth > 0 && ++end < source.length) {
    if (source[end] === "{") depth++;
    if (source[end] === "}") depth--;
  }
  if (depth !== 0) throw new Error(`Unclosed ${signature}`);
  return source.slice(start, end + 1);
}

test("dynamic imports load their dependency graph before finishing the native import", () => {
  expect(definition(shim, "bool module_load(")).toContain("finish_module_load(cx, referrer, request, payload, module)");
  const load = definition(shim, "bool finish_module_load(JSContext* cx, JS::HandleValue referrer, JS::HandleObject request,\n                        JS::HandleValue payload, JS::HandleObject module) {");
  expect(load).toContain("JS::IsPromiseObject");
  expect(load).toContain("JS::LoadRequestedModules(cx, module, JS::UndefinedHandleValue, &loading)");
  expect(load).toContain("JS::AddPromiseReactions(cx, loading, fulfilled, rejected)");
  expect(definition(shim, "bool dynamic_module_loaded(")).toContain("JS::FinishLoadingImportedModule(cx, referrer, request, payload, module, true)");
});

test("module evaluation waits for graph loading and keeps the namespace reaction separate", () => {
  const evaluate = definition(shim, "bool evaluate_module(");
  expect(evaluate).toContain("JS::LoadRequestedModules(context, module, hostDefined, &loading)");
  expect(evaluate).toContain("module_evaluate_handler");
  expect(evaluate).toContain("JS::AddPromiseReactions(context, loading");
  expect(definition(shim, "bool module_evaluate_handler(")).toContain("JS::ModuleLink");
  expect(definition(shim, "bool module_evaluate_handler(")).toContain("JS::ModuleEvaluate");
  expect(definition(shim, 'extern "C" bool bsm_import(')).toContain("namespace_promise");
});

test("external buffers are pinned and only their own weak identities may be detached", () => {
  expect(shim).not.toContain("std::vector<JS::PersistentRootedObject*> externalBuffers");
  const create = definition(shim, 'extern "C" bsm_handle bsm_external_buffer(');
  expect(create).toContain("JS::PinArrayBufferOrViewLength(obj, true)");
  expect(create).toContain("JS::SetWeakMapEntry");
  const detach = definition(shim, 'extern "C" bool bsm_detach_external(');
  expect(detach).toContain("is_external_buffer(obj)");
  expect(detach).toContain("JS::PinArrayBufferOrViewLength(obj, false)");
  expect(detach).not.toContain("externalBuffers.erase");
  expect(detach.indexOf("JS::PinArrayBufferOrViewLength(obj, false)")).toBeLessThan(detach.indexOf("JS::DetachArrayBuffer"));
  expect(detach).not.toContain("return JS::IsArrayBufferObject(obj)");
  expect(definition(shim, 'extern "C" bool bsm_is_detachable_buffer(')).toContain("JS::HasDefinedArrayBufferDetachKey");
});

test("native errors use captured constructors and CommonJS compilation keeps body line one", () => {
  expect(definition(shim, 'extern "C" bsm_handle bsm_error(')).not.toContain("JS_GetProperty");
  expect(shim).toContain("js::SetStackFormat(context, js::StackFormat::SpiderMonkey)");
  expect(definition(shim, 'extern "C" bool bsm_eval_script(')).not.toContain("line > 0 ? line : 1");
  expect(definition(shim, "bool compile_commonjs(")).toContain("JS::Compile(context, options, text)");
});

test("interrupt exit consumes the latched engine outcome, not a second host poll", () => {
  expect(definition(adapter, "fn terminate()")).not.toContain("host.interrupt()");
  expect(definition(adapter, "fn terminate()")).toContain("sys::bsm_terminated()");
  expect(definition(adapter, "fn set(")).toContain("checked(ok, out)");
  expect(definition(shim, 'extern "C" void bunsm_poll_interrupt(')).toContain("terminating || !interruptible");
});

test("job frames restore after execution and checkpoints release kept objects", () => {
  const run = definition(shim, "bool run_task(");
  expect(run).toContain("JS::RunJSMicroTask");
  expect(run).toContain("asyncContext->set(previous)");
  expect(run.indexOf("JS::RunJSMicroTask")).toBeLessThan(run.indexOf("asyncContext->set(previous)"));
  expect(definition(shim, 'extern "C" bool bsm_drain_jobs(')).toContain("JS::ClearKeptObjects");
  expect(definition(shim, "void Queue::runJobs(")).toContain("if (isDrainingStopped()) return;");
});

test("native promise reactions validate primitives and bypass public promise hooks", () => {
  const reaction = definition(shim, 'extern "C" bool bsm_promise_then(');
  expect(reaction).toContain("if (!p)");
  expect(reaction).toContain("JS::CallOriginalPromiseThen");
  expect(reaction).not.toContain("JS_GetProperty");
});

function compileCommonjsControl(root: string): string {
  const input = join(root, "lines.cpp");
  const output = join(root, "lines");
  writeFileSync(input, String.raw`#include <cassert>
#include <cstring>
#include <string>
#include <string_view>
#include <cstdint>
${definition(shim, "bool commonjs_body(")}
${definition(shim, "std::string commonjs_source(")}
int main() {
  const std::string prefix = "(function __bunwasm_cjs__(exports, require, module, __filename, __dirname) {\n\n";
  const std::string source = prefix + "return this;\n// body unchanged" + "\n})";
  std::string_view body;
  assert(commonjs_body(source.data(), source.size(), -1, &body));
  assert(body == "return this;\n// body unchanged");
  assert(body.data() == source.data() + prefix.size());
  const std::string adjusted = commonjs_source(source.data(), source.size(), body);
  assert(adjusted.size() == source.size() - 1);
  assert(adjusted.substr(prefix.size() - 1, body.size()) == body);
  assert(adjusted.substr(0, prefix.size() - 1) == prefix.substr(0, prefix.size() - 1));
  assert(adjusted.substr(adjusted.size() - 3) == "\n})");
  assert(!commonjs_body(source.data(), source.size(), -2, &body));
  assert(!commonjs_body(source.data(), source.size(), 0, &body));
  assert(!commonjs_body(source.data(), source.size(), 17, &body));
  assert(!commonjs_body("42", 2, -1, &body));
  assert(!commonjs_body(source.data() + 1, source.size() - 1, -1, &body));
  assert(!commonjs_body(source.data(), source.size() - 1, -1, &body));
  const std::string empty = prefix + "\n})";
  assert(commonjs_body(empty.data(), empty.size(), -1, &body));
  assert(body.empty());
}
`);
  const build = Bun.spawnSync(["c++", "-std=c++20", "-Wall", "-Wextra", "-Werror", input, "-o", output]);
  expect(build.stderr.toString()).toBe("");
  expect(build.exitCode).toBe(0);
  return output;
}

function compileFinalizerControl(root: string): string {
  const source = `use std::{cell::RefCell, collections::HashMap, rc::Rc};
thread_local! {
    static NATIVES: RefCell<HashMap<u32, Rc<dyn Fn()>>> = RefCell::new(HashMap::new());
    static DEAD: RefCell<Vec<u32>> = const { RefCell::new(Vec::new()) };
}
${definition(adapter, "fn drop_dead_natives()")}
struct Reenter;
impl Drop for Reenter {
    fn drop(&mut self) { NATIVES.with(|natives| { natives.borrow_mut().insert(2, Rc::new(|| {})); }); }
}
fn main() {
    let owned = Reenter;
    NATIVES.with(|natives| { natives.borrow_mut().insert(1, Rc::new(move || { let _ = &owned; })); });
    DEAD.with(|dead| dead.borrow_mut().push(1));
    drop_dead_natives();
    NATIVES.with(|natives| assert!(natives.borrow().contains_key(&2)));
    DEAD.with(|dead| assert!(dead.borrow().is_empty()));
    drop_dead_natives();
}
`;
  const input = join(root, "finalizer.rs");
  const output = join(root, "finalizer");
  writeFileSync(input, source);
  const build = Bun.spawnSync(["rustup", "run", "stable", "rustc", "--edition=2024", input, "-o", output]);
  expect(build.stderr.toString()).toBe("");
  expect(build.exitCode).toBe(0);
  return output;
}

// Compiler startup belongs to module setup, not either five-second runtime test.
function compileControls() {
  const root = mkdtempSync(join(tmpdir(), "bun-wasm-sm-semantics-"));
  try {
    return {
      commonjs: readFileSync(compileCommonjsControl(root)),
      finalizer: readFileSync(compileFinalizerControl(root)),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
const controls = compileControls();

function runControl(executable: Uint8Array) {
  const root = mkdtempSync(join(tmpdir(), "bun-wasm-sm-semantics-"));
  try {
    const output = join(root, "control");
    writeFileSync(output, executable, { mode: 0o755 });
    return Bun.spawnSync([output]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("the real CommonJS wrapper keeps its exact body and other negative shapes reject", () => {
  const modules = readFileSync("crates/bunwasm-runtime/src/modules.rs", "utf8");
  expect(modules).toContain("(function __bunwasm_cjs__(exports, require, module, __filename, __dirname) {{\\n\\n{code}\\n}})");
  const run = runControl(controls.commonjs);
  expect(run.stderr.toString()).toBe("");
  expect(run.exitCode).toBe(0);
  const evaluate = definition(shim, 'extern "C" bool bsm_eval_script(');
  expect(evaluate).toContain("if (line < 0) return compile_commonjs");
  expect(evaluate).toContain("options.setFileAndLine(filename, static_cast<uint32_t>(line))");
  expect(definition(shim, "bool compile_commonjs(")).toContain("options.setFileAndLine(filename, 0)");
});

test("deferred native destruction permits destructor reentry into the registry", () => {
  const run = runControl(controls.finalizer);
  expect(run.stderr.toString()).toBe("");
  expect(run.exitCode).toBe(0);
});

test("module evaluation forwards settlement without adopting its internal promise", () => {
  const evaluate = definition(shim, "bool evaluate_module(");
  const handler = definition(shim, "bool module_evaluate_handler(");
  expect(evaluate).toContain("JS::NewPromiseObject");
  expect(evaluate).toContain("JS::AddPromiseReactions");
  expect(handler).toContain("JS::AddPromiseReactions");
  expect(handler).not.toContain("args.rval())");
});

test("CommonJS uses its original named expression, not a with-object self binding", () => {
  const compile = definition(shim, "bool compile_commonjs(");
  expect(compile).not.toContain("nameScope");
  expect(compile).not.toContain("JS::EnvironmentChain");
  expect(compile).toContain("JS::Compile(context, options, text)");
});

test("error formatting reads saved-frame metadata through an immutable internal capability", () => {
  const capture = definition(shim, "bool error_frames(");
  expect(capture).toContain("JS::ExceptionStackOrNull");
  expect(capture).toContain("JS::GetSavedFrameAsyncCause");
  expect(capture).toContain("JS::GetSavedFrameParent");
  expect(capture).toContain("JS_CompareStrings");
  expect(capture).not.toContain("JS_GetProperty");
  const install = definition(shim, "bool install_error_frames(");
  expect(install).toContain("JSPROP_READONLY | JSPROP_PERMANENT");
  expect(shim).toContain("saved-frame reader installation failed");
});

test("the engine realm enables standard shared memory before creating its global", () => {
  const initialize = definition(shim, "extern \"C\" void bsm_init(const bsm_config* config)");
  const enable = "options.creationOptions().setSharedMemoryAndAtomicsEnabled(true)";
  expect(initialize).toContain(enable);
  expect(initialize.indexOf(enable)).toBeLessThan(initialize.indexOf("JS_NewGlobalObject"));
});
