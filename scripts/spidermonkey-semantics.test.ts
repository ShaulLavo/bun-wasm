import { expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { definition, nativeControls } from "./spidermonkey-native-controls";

const shim = readFileSync("crates/bunwasm-spidermonkey/cpp/engine.cpp", "utf8");
const adapter = readFileSync("crates/bunwasm-engine-spidermonkey/src/vm.rs", "utf8");

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

function compilerProgress(label: string, event: string): void {
  const trace = process.env.BUN_WASM_SM_COMPILER_TRACE;
  if (!trace) return;
  try { appendFileSync(`${trace}.progress`, `${Date.now()} ${label} ${event}\n`); }
  catch { /* A trace failure must preserve the compiler outcome. */ }
}

async function buildControl(command: string[], output: string): Promise<string> {
  const build = Bun.spawn(command, { stdout: "ignore", stderr: "pipe" });
  const label = command[0]!;
  compilerProgress(label, `spawned ${build.pid}`);
  const stderrDone = new Response(build.stderr).text().then(text => {
    compilerProgress(label, `stderr-eof ${text.length}`);
    return text;
  });
  const exited = build.exited.then(code => {
    compilerProgress(label, `exited ${code} ${build.signalCode ?? "-"}`);
    return code;
  });
  const [stderr, exitCode] = await Promise.all([stderrDone, exited]);
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
  return output;
}

// Compiler startup belongs to module setup, not either five-second runtime test.
async function compileControls() {
  const root = mkdtempSync(join(tmpdir(), "bun-wasm-sm-semantics-"));
  try {
    const [commonjs, finalizer] = await Promise.allSettled(nativeControls(root).map(control => {
      writeFileSync(control.input, control.source);
      return buildControl(control.command, control.output);
    }));
    if (!commonjs || !finalizer) throw new Error("Missing native controls");
    if (commonjs.status === "rejected") throw commonjs.reason;
    if (finalizer.status === "rejected") throw finalizer.reason;
    return { commonjs: readFileSync(commonjs.value), finalizer: readFileSync(finalizer.value) };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
const controls = await compileControls();

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
