import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { compilerResources } from "./ci-native-control-compilers";
import { nativeControls } from "./spidermonkey-native-controls";

const repository = resolve(import.meta.dir, "..");
const inputs = [
  "scripts/ci-native-control-compilers.ts", "scripts/spidermonkey-native-controls.ts",
  "scripts/spidermonkey-semantics.test.ts", "crates/bunwasm-runtime/src/modules.rs", "rust-toolchain.toml",
  "crates/bunwasm-spidermonkey/cpp/engine.cpp", "crates/bunwasm-engine-spidermonkey/src/vm.rs",
];
const realCxx = Bun.which("c++");
const realRustup = Bun.which("rustup");
if (!realCxx || !realRustup) throw new Error("Preinstalled c++ and rustup are required");

function quoted(text: string): string { return `'${text.replaceAll("'", "'\\''")}'`; }

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "bun-wasm-compiler-readiness-test-"));
  try {
    for (const input of inputs) {
      const path = join(root, input);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, readFileSync(join(repository, input)));
    }
    mkdirSync(join(root, "bin"));
    mkdirSync(join(root, "tmp"));
    return root;
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function wrapper(root: string, tool: "c++" | "rustup", compile = "", version = "") {
  const executable = tool === "c++" ? realCxx! : realRustup!;
  const sourceIndex = 5;
  const script = `#!/bin/sh
case " $* " in
  *" --version "*)
    printf '%s|%s|%s\\n' "$*" "$RUSTUP_TOOLCHAIN" "$RUSTUP_AUTO_INSTALL" >> ${quoted(join(root, `${tool}.versions`))}
    ${version}
    exec ${quoted(executable)} "$@"
    ;;
esac
printf '%s\\n' "$$" > ${quoted(join(root, `${tool}.pid`))}
printf '%s\\n' "$@" > ${quoted(join(root, `${tool}.args`))}
cp "$${sourceIndex}" ${quoted(join(root, `${tool}.source`))}
printf '%s\\n' '${tool} started' >> ${quoted(join(root, "events"))}
${compile}
printf '%s\\n' '${tool} exec' >> ${quoted(join(root, "events"))}
exec ${quoted(executable)} "$@"
`;
  writeFileSync(join(root, "bin", tool), script, { mode: 0o755 });
}

function killGroup(pid: number): void {
  try { process.kill(-pid, "SIGKILL"); }
  catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error;
  }
}

function live(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return !/^[ZX] /.test(stat.slice(stat.lastIndexOf(")") + 2));
  } catch { return false; }
}

function groupMembers(group: number): number[] {
  if (process.platform !== "linux") throw new Error("Readiness cleanup tests require the Linux execution host");
  return readdirSync("/proc").filter(pid => /^\d+$/.test(pid)).flatMap(pid => {
    try {
      const text = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
      return Number(fields[2]) === group && fields[0] !== "Z" && fields[0] !== "X" ? [Number(pid)] : [];
    } catch { return []; }
  });
}

function assertClean(root: string) {
  expect(readdirSync(join(root, "tmp"))).toEqual([]);
  for (const tool of ["c++", "rustup"]) {
    const path = join(root, `${tool}.pid`);
    if (!existsSync(path)) continue;
    const pid = Number(readFileSync(path, "utf8"));
    expect(live(pid)).toBe(false);
    expect(groupMembers(pid)).toEqual([]);
  }
}

async function run(root: string, ready?: (child: Bun.Subprocess) => Promise<void>, environment = process.env) {
  const child = Bun.spawn([process.execPath, "scripts/ci-native-control-compilers.ts"], {
    cwd: root, detached: true, stdout: "pipe", stderr: "pipe",
    env: { ...environment, TMPDIR: join(root, "tmp"), PATH: `${join(root, "bin")}:${environment.PATH}` },
  });
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  try {
    await ready?.(child);
    const [out, err, exitCode] = await Promise.all([stdout, stderr, child.exited]);
    // Check the script's cleanup before the outer safety teardown can hide a leak.
    for (const row of records(out)) {
      if (typeof row.pid === "number") expect(groupMembers(row.pid)).toEqual([]);
    }
    assertClean(root);
    return { out, err, exitCode };
  } finally {
    killGroup(child.pid);
    for (const tool of ["c++", "rustup"]) {
      const pid = join(root, `${tool}.pid`);
      if (existsSync(pid)) killGroup(Number(readFileSync(pid, "utf8")));
    }
    await Promise.allSettled([stdout, stderr, child.exited]);
    expect(groupMembers(child.pid)).toEqual([]);
  }
}

async function withFixture(body: (root: string) => Promise<void>) {
  const root = fixture();
  try { await body(root); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

function records(output: string): Record<string, unknown>[] {
  return output.trim().split("\n").map(line => JSON.parse(line));
}

test("preparation compiles and runs the exact controls once with real overlapping compiler slots", async () => {
  await withFixture(async root => {
    execFileSync("mkfifo", [join(root, "cxx.fifo"), join(root, "rust.fifo")]);
    wrapper(root, "c++", `printf 'ready\\n' > ${quoted(join(root, "cxx.fifo"))}\nread -r peer < ${quoted(join(root, "rust.fifo"))}`);
    wrapper(root, "rustup", `read -r peer < ${quoted(join(root, "cxx.fifo"))}\nprintf 'ready\\n' > ${quoted(join(root, "rust.fifo"))}`);
    const result = await run(root);
    expect(result.exitCode, result.err).toBe(0);
    const events = readFileSync(join(root, "events"), "utf8").trim().split("\n");
    expect(events.slice(0, 2).sort()).toEqual(["c++ started", "rustup started"]);
    expect(events.slice(2).sort()).toEqual(["c++ exec", "rustup exec"]);
    expect(readFileSync(join(root, "c++.versions"), "utf8").trim().split("\n")).toEqual(["--version|stable|0"]);
    expect(readFileSync(join(root, "rustup.versions"), "utf8").trim().split("\n")).toEqual([
      "--version|stable|0", "run stable rustc --version --verbose|stable|0",
    ]);
    const rows = records(result.out);
    expect(rows[0]?.phase).toBe("preparation-start");
    expect(rows.filter(row => row.phase === "version")).toHaveLength(3);
    expect(rows.filter(row => row.phase === "execute")).toHaveLength(2);
    const compileTime = rows.find(row => row.phase === "compile-complete")?.wallMs;
    expect(typeof compileTime).toBe("number");
    expect(Number(rows.at(-1)?.totalMs)).toBeGreaterThanOrEqual(Number(compileTime));
    const compiles = rows.filter(row => row.phase === "compile");
    expect(compiles).toHaveLength(2);
    for (const row of compiles) expectCounters(row);
    expect(rows.at(-1)).toMatchObject({ phase: "preparation-complete", success: true });
    const total = rows.at(-1)?.totalMs;
    const versions = rows.find(row => row.phase === "version-complete")?.wallMs;
    expect(typeof total).toBe("number");
    expect(typeof versions).toBe("number");
    expect(Number(total)).toBeGreaterThanOrEqual(Number(versions));
    const sourceRoot = dirname(readFileSync(join(root, "c++.args"), "utf8").trim().split("\n")[4]!);
    for (const control of nativeControls(sourceRoot, root)) expectRecordedControl(root, control);
    assertClean(root);
  });
});

function expectCounters(row: Record<string, unknown>) {
  expect(row).toMatchObject({ exitCode: 0, signal: null });
  expect(Number(row.wallMsThroughExitAndEof)).toBeGreaterThanOrEqual(0);
  expect(row.cpuMs === null || typeof row.cpuMs === "number").toBe(true);
  expect(row.blockInputOps === null || Number.isSafeInteger(row.blockInputOps)).toBe(true);
}

function expectRecordedControl(root: string, control: ReturnType<typeof nativeControls>[number]) {
  expect(readFileSync(join(root, `${control.label}.source`), "utf8")).toBe(control.source);
  expect(readFileSync(join(root, `${control.label}.args`), "utf8").trim().split("\n")).toEqual(control.command.slice(1));
}

test("version failures remain distinct from compile failures", async () => {
  await withFixture(async root => {
    wrapper(root, "c++", "", "echo version-rejected >&2; exit 9");
    wrapper(root, "rustup");
    const result = await run(root);
    expect(result.exitCode).toBe(1);
    expect(result.err).toContain("version c++ exited 9");
    expect(result.err).toContain("version-rejected");
    expect(result.out).not.toContain('"phase":"compile-start"');
    assertClean(root);
  });
});

test("compile exit seven stops its live sibling and removes partial outputs", async () => {
  await withFixture(async root => {
    execFileSync("mkfifo", [join(root, "active.fifo")]);
    wrapper(root, "c++", `touch "$7"\nprintf 'active\\n' > ${quoted(join(root, "active.fifo"))}\nexec sleep 30`);
    wrapper(root, "rustup", `read -r peer < ${quoted(join(root, "active.fifo"))}\necho compile-rejected >&2\nexit 7`);
    const result = await run(root);
    expect(result.exitCode).toBe(1);
    expect(result.err).toContain("compile rustup exited 7");
    expect(result.err).toContain("compile-rejected");
    expect(result.out).toContain('"phase":"compile-start"');
    assertClean(root);
  });
});

test("a real compiler rejection remains blocking", async () => {
  await withFixture(async root => {
    wrapper(root, "c++", 'printf "%s\\n" "invalid C++ source" > "$5"');
    wrapper(root, "rustup");
    const result = await run(root);
    expect(result.exitCode).toBe(1);
    expect(result.err).toContain("compile c++ exited 1");
    expect(result.err).toContain("error:");
    assertClean(root);
  });
});

test("a failed second spawn tears down the first tracked compiler", async () => {
  await withFixture(async root => {
    const active = join(root, "first-active.fifo");
    execFileSync("mkfifo", [active]);
    wrapper(root, "c++", `touch "$7"\nprintf 'active\\n' > ${quoted(active)}\nexec sleep 30`);
    wrapper(root, "rustup");
    // Fail the real second spawn only after the first tracked writer is alive.
    const path = join(root, "scripts/ci-native-control-compilers.ts");
    const launch = "    const process = launch(command, phase, root, capture);";
    const failure = `    if (phase === "compile" && command[0] === "rustup") {
      readFileSync(${JSON.stringify(active)}, "utf8");
      command[0] = ${JSON.stringify(join(root, "missing-rustup"))};
    }
${launch}`;
    const source = readFileSync(path, "utf8");
    expect(source).toContain(launch);
    writeFileSync(path, source.replace(launch, failure));
    const result = await run(root);
    expect(result.exitCode).toBe(1);
    expect(result.err).toContain("missing-rustup");
    expect(result.err).toContain("compile");
    expect(result.err).toContain("spawn failed");
    expect(result.out).toContain('"phase":"compile-start"');
    expect(existsSync(join(root, "c++.pid"))).toBe(true);
    assertClean(root);
  });
});

test("catchable interruption stops active compiler groups before deleting partial outputs", async () => {
  await withFixture(async root => {
    execFileSync("mkfifo", [join(root, "ready.fifo")]);
    wrapper(root, "c++", 'touch "$7"\nexec sleep 30');
    wrapper(root, "rustup", `printf 'ready\\n' > ${quoted(join(root, "ready.fifo"))}\nexec sleep 30`);
    const result = await run(root, async child => {
      // A FIFO read completes only after the Rust slot has started.
      await Bun.file(join(root, "ready.fifo")).text();
      child.kill("SIGTERM");
    });
    expect(result.exitCode).toBe(1);
    expect(result.err).toContain("preparation interrupted by SIGTERM");
    assertClean(root);
  });
});

test("shared control construction reads the current copied adapter and import has no execution", async () => {
  await withFixture(async root => {
    const adapter = join(root, "crates/bunwasm-engine-spidermonkey/src/vm.rs");
    const before = nativeControls(join(root, "tmp"), root);
    writeFileSync(adapter, readFileSync(adapter, "utf8").replace("fn drop_dead_natives() {", "fn drop_dead_natives() {\n    let _changed = 42;"));
    const after = nativeControls(join(root, "tmp"), root);
    expect(after[1]?.source).not.toBe(before[1]?.source);
    expect(after[1]?.source).toContain("let _changed = 42;");
    expect(after[0]).toEqual(before[0]);
    expect(readdirSync(join(root, "tmp"))).toEqual([]);
    const imported = Bun.spawnSync([process.execPath, "-e", 'await import("./scripts/spidermonkey-native-controls.ts")'], { cwd: root });
    expect(imported.exitCode).toBe(0);
    expect(imported.stdout.length).toBe(0);
    expect(imported.stderr.length).toBe(0);
    expect(readdirSync(join(root, "tmp"))).toEqual([]);
  });
});

test("compiler resource units are milliseconds and input operation counts, with unavailable counters null", () => {
  expect(compilerResources(null)).toEqual({ cpuMs: null, blockInputOps: null });
  const child = Bun.spawnSync([process.execPath, "-e", ""]);
  const usage = child.resourceUsage;
  if (!usage) throw new Error("The actual-host resource reading is required for this conversion control");
  expect(compilerResources({ ...usage, cpuTime: { ...usage.cpuTime, total: 2500 }, ops: { ...usage.ops, in: 7 } })).toEqual({ cpuMs: 2.5, blockInputOps: 7 });
});

test("trace-disabled direct semantics execution creates no progress file", async () => {
  await withFixture(async root => {
    wrapper(root, "c++");
    wrapper(root, "rustup");
    const child = Bun.spawnSync([process.execPath, "test", "./scripts/spidermonkey-semantics.test.ts"], {
      cwd: root, env: { ...process.env, TMPDIR: join(root, "tmp"), PATH: `${join(root, "bin")}:${process.env.PATH}`, BUN_WASM_SM_COMPILER_TRACE: undefined },
    });
    expect(child.exitCode, child.stderr.toString()).toBe(0);
    const sourceRoot = dirname(readFileSync(join(root, "c++.args"), "utf8").trim().split("\n")[4]!);
    for (const control of nativeControls(sourceRoot, root)) expectRecordedControl(root, control);
    expect(readdirSync(root, { recursive: true }).filter(path => path.toString().endsWith(".progress"))).toEqual([]);
    assertClean(root);
  });
});

test("missing stable fails without installing the repository-pinned nightly or any toolchain", async () => {
  await withFixture(async root => {
    const rustupHome = join(root, "empty-rustup");
    mkdirSync(rustupHome);
    wrapper(root, "c++");
    wrapper(root, "rustup");
    const result = await run(root, undefined, { ...process.env, RUSTUP_HOME: rustupHome });
    expect(result.exitCode).toBe(1);
    expect(result.err).toContain("stable");
    expect(result.out).not.toContain('"phase":"compile-start"');
    expect(readdirSync(rustupHome).filter(name => ["toolchains", "downloads", "tmp"].includes(name))).toEqual([]);
    assertClean(root);
  });
});

test("a compiled output failure keeps its runtime diagnostics and remains blocking", async () => {
  await withFixture(async root => {
    wrapper(root, "c++");
    wrapper(root, "rustup");
    const adapter = join(root, "crates/bunwasm-engine-spidermonkey/src/vm.rs");
    const source = readFileSync(adapter, "utf8");
    writeFileSync(adapter, source.replace(/fn drop_dead_natives\(\) \{[\s\S]*?\n\}/, `fn drop_dead_natives() {
    let dead = DEAD.with(|dead| dead.borrow_mut().drain(..).collect::<Vec<_>>());
    NATIVES.with(|natives| {
        let mut natives = natives.borrow_mut();
        for id in dead { drop(natives.remove(&id)); }
    });
}`));
    const result = await run(root);
    expect(result.exitCode).toBe(1);
    expect(result.err).toContain("execute");
    expect(result.err).toContain("RefCell already borrowed");
    assertClean(root);
  });
});
