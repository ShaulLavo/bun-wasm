import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeControls } from "./spidermonkey-native-controls";

type Child = ReturnType<typeof launch>;
type OwnedCompiler = { process: Child; done: Promise<unknown>; boundaries: Promise<unknown>[] };

function launch(command: string[], phase: string, root: string, capture: boolean) {
  const started = performance.now();
  try {
    const child = Bun.spawn(command, {
      detached: true,
      env: { ...process.env, TMPDIR: root, RUSTUP_TOOLCHAIN: "stable", RUSTUP_AUTO_INSTALL: "0" },
      stdout: capture ? "pipe" : "ignore",
      stderr: "pipe",
    });
    return { child, command, phase, started };
  } catch (error) {
    throw new Error(`${phase} ${command[0]} spawn failed: ${String(error)}`, { cause: error });
  }
}

function signalGroup(pid: number): void {
  try { process.kill(-pid, "SIGKILL"); }
  catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error;
  }
}

function liveGroup(pid: number): boolean {
  if (process.platform !== "linux") {
    try { process.kill(-pid, 0); return true; }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
      throw error;
    }
  }
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const stat = readStat(entry);
    if (stat && Number(stat[2]) === pid && stat[0] !== "Z" && stat[0] !== "X") return true;
  }
  return false;
}

function readStat(pid: string): string[] | null {
  try {
    const text = readFileSync(`/proc/${pid}/stat`, "utf8");
    const end = text.lastIndexOf(")");
    if (end < 0) throw new Error(`Malformed owned-process stat ${pid}`);
    return text.slice(end + 2).trim().split(/\s+/);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

export function compilerResources(usage: ReturnType<Child["child"]["resourceUsage"]> | null) {
  return {
    cpuMs: usage ? Number(usage.cpuTime.total) / 1000 : null,
    blockInputOps: usage ? Number(usage.ops.in) : null,
  };
}

async function cleanupCompilers(owned: OwnedCompiler[], root: string, errors: unknown[]) {
  for (const entry of owned) {
    try { signalGroup(entry.process.child.pid); }
    catch (error) { errors.push(error); }
  }
  await Promise.allSettled(owned.flatMap(entry => entry.boundaries.concat([entry.done])));
  const live = owned.filter(entry => liveGroup(entry.process.child.pid));
  if (live.length) throw new Error(`Owned groups remain live: ${live.map(entry => entry.process.child.pid).join(", ")}`);
  if (errors.length) throw new AggregateError(errors, "Failed to stop owned groups");
  rmSync(root, { recursive: true, force: true });
}

async function result(owned: Child, stdout: Promise<string>, errorOutput: Promise<string>) {
  const { child, phase, command, started } = owned;
  const [out, stderr, exitCode] = await Promise.all([stdout, errorOutput, child.exited]);
  const usage = child.resourceUsage();
  const metrics = {
    phase, tool: command[0], pid: child.pid, exitCode, signal: child.signalCode ?? null,
    wallMsThroughExitAndEof: performance.now() - started,
    ...compilerResources(usage),
  };
  console.log(JSON.stringify({ ...metrics, ...(phase === "version" ? { identity: out.trim(), stderr: stderr.trim() } : {}) }));
  if (exitCode !== 0 || child.signalCode || (phase !== "version" && stderr !== "")) {
    throw new Error(`${phase} ${command[0]} exited ${exitCode} signal ${child.signalCode ?? "-"}: ${stderr}`);
  }
  return metrics;
}

export async function prepareNativeControlCompilers(): Promise<void> {
  const started = performance.now();
  console.log(JSON.stringify({ phase: "preparation-start", tools: "preinstalled c++ and stable Rust" }));
  const owned: OwnedCompiler[] = [];
  const root = mkdtempSync(join(tmpdir(), "bun-wasm-native-compilers-"));
  const cleanupErrors: unknown[] = [];
  let interrupted: Error | undefined;
  const interrupt = (signal: string) => {
    interrupted ??= new Error(`preparation interrupted by ${signal}`);
    for (const entry of owned) {
      try { signalGroup(entry.process.child.pid); }
      catch (error) { cleanupErrors.push(error); }
    }
  };
  const term = () => interrupt("SIGTERM");
  const int = () => interrupt("SIGINT");
  process.on("SIGTERM", term);
  process.on("SIGINT", int);
  let primary: unknown;
  const run = (command: string[], phase: string, capture = false) => {
    if (interrupted) throw interrupted;
    const process = launch(command, phase, root, capture);
    // Own the group before stream consumption or the next spawn can fail.
    const entry: OwnedCompiler = { process, done: Promise.resolve(undefined), boundaries: [process.child.exited] };
    owned.push(entry);
    const stdout = process.child.stdout instanceof ReadableStream ? new Response(process.child.stdout).text() : Promise.resolve("");
    entry.boundaries.push(stdout);
    const stderr = new Response(process.child.stderr).text();
    entry.boundaries.push(stderr);
    entry.done = result(process, stdout, stderr);
    void entry.done.catch(() => {});
    return entry.done;
  };
  try {
    console.log(JSON.stringify({ phase: "version-start" }));
    const versionStarted = performance.now();
    await run(["c++", "--version"], "version", true);
    // Explicit stable selection prevents the repository's nightly pin from installing anything.
    await run(["rustup", "--version"], "version", true);
    await run(["rustup", "run", "stable", "rustc", "--version", "--verbose"], "version", true);
    console.log(JSON.stringify({ phase: "version-complete", wallMs: performance.now() - versionStarted }));
    const controls = nativeControls(root);
    for (const control of controls) writeFileSync(control.input, control.source);
    const compileStarted = performance.now();
    console.log(JSON.stringify({ phase: "compile-start" }));
    const builds = controls.map(control => run(control.command, "compile"));
    await Promise.all(builds);
    console.log(JSON.stringify({ phase: "compile-complete", wallMs: performance.now() - compileStarted }));
    console.log(JSON.stringify({ phase: "execute-start" }));
    await Promise.all(controls.map(control => run([control.output], "execute")));
    if (interrupted) throw interrupted;
  } catch (error) {
    primary = interrupted ?? error;
  } finally {
    try {
      await cleanupCompilers(owned, root, cleanupErrors);
    } catch (error) {
      console.error(`Cleanup failed; retained scratch ${root}: ${String(error)}`);
      primary ??= error;
    }
    primary ??= interrupted;
    process.off("SIGTERM", term);
    process.off("SIGINT", int);
    console.log(JSON.stringify({ phase: "preparation-complete", totalMs: performance.now() - started, success: primary === undefined }));
  }
  if (primary !== undefined) throw primary;
}

if (import.meta.main) {
  try { await prepareNativeControlCompilers(); }
  catch (error) { console.error(String(error)); process.exitCode = 1; }
}
