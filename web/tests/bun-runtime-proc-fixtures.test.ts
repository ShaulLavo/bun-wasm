import { expect, test } from "bun:test";
import type { SpawnRequest } from "waffle/proc/types";
import { bunRuntimeProcFixture, bunRuntimeProcScenarios } from "./bun-runtime-proc-fixtures";

for (const scenario of bunRuntimeProcScenarios) test(`external generic root fixture ${scenario.name} retains requests, fds and blocking job status checks`, () => {
  const bytes = bunRuntimeProcFixture(scenario);
  expect(WebAssembly.validate(bytes)).toBe(true);
  const module = new WebAssembly.Module(bytes);
  expect(WebAssembly.Module.imports(module).filter(item => item.module === "runtime_proc").map(item => item.name))
    .toEqual(["spawn", "job_of", "wait_job", "write", "pipe", "read", "poll", "kill_job"]);
  let memory: WebAssembly.Memory;
  const requests: SpawnRequest[] = [], waited: number[] = [], closed: number[] = [];
  const output: string[] = [];
  const killed: number[] = [];
  let reads = 0;
  const instance = new WebAssembly.Instance(module, {
    runtime_proc: {
      spawn(pointer: number, length: number) {
        const spec: SpawnRequest = JSON.parse(new TextDecoder().decode(new Uint8Array(memory.buffer, pointer, length)));
        requests.push(spec); return requests.length + 10;
      },
      job_of(pid: number) { return pid + 100; },
      wait_job(job: number, flags: number, pointer: number) {
        expect(flags).toBe(0); waited.push(job);
        const command = scenario.commands[waited.length - 1]!;
        const view = new DataView(memory.buffer);
        view.setInt32(pointer, command.kind ?? 0, true);
        view.setInt32(pointer + 4, command.status ?? 0, true);
        return 0;
      },
      write(_fd: number, pointer: number, length: number) {
        output.push(new TextDecoder().decode(new Uint8Array(memory.buffer, pointer, length))); return length;
      },
      pipe(pointer: number) { const view = new DataView(memory.buffer); view.setInt32(pointer, 123, true); view.setInt32(pointer + 4, 456, true); return 0; },
      read(fd: number, pointer: number, length: number) {
        if (scenario.fileCursor) {
          expect(fd).toBe(123);
          const value = ++reads === 1 ? "xx" : "!";
          expect(length).toBe(value.length);
          new Uint8Array(memory.buffer).set(new TextEncoder().encode(value), pointer);
          return length;
        }
        if (++reads % 2 === 1) return -6; new Uint8Array(memory.buffer)[pointer] = 82; return 1;
      },
      poll() { return 1; },
      kill_job(job: number, signal: number) { expect(signal).toBe(9); killed.push(job); return 0; },
    },
    wasi_snapshot_preview1: {
      path_open(fd: number, flags: number, path: number, length: number, oflags: number, rights: bigint, inheriting: bigint, fdflags: number, result: number) {
        const expectedRights = scenario.fileCursor === "positioned" ? (1n << 21n) | 6n : 2n;
        expect([fd, flags, oflags, rights, inheriting, fdflags]).toEqual([3, 0, 0, expectedRights, 0n, 0]);
        expect(new TextDecoder().decode(new Uint8Array(memory.buffer, path, length))).toBe("home/user/inherited-cursor");
        new DataView(memory.buffer).setUint32(result, 123, true); return 0;
      },
      fd_close(fd: number) { closed.push(fd); return 0; },
      proc_exit(code: number) { throw new Error(`external root failed stage ${code}`); },
    },
  });
  memory = instance.exports.memory as WebAssembly.Memory;
  (instance.exports._start as () => void)();
  expect(requests).toHaveLength(scenario.commands.length);
  for (const [index, request] of requests.entries()) {
    const command = scenario.commands[index]!;
    expect(request).toEqual({ executable: command.executable ?? "/bin/bun", argv: ["bun", "-e", command.source],
      env: { PWD: "/home/user", PATH: scenario.basePrograms ? "/usr/local/bin:/usr/bin:/bin" : "/bin:/usr/bin" }, cwd: "/home/user", job: 0,
      fds: (command.fds ?? [{ child: 0, parent: 0 }, { child: 1, parent: 1 }, { child: 2, parent: 2 }]).map(binding => ({
        child: binding.child, parent: binding.parent === "reader" ? 123 : binding.parent === "writer" ? 456 : binding.parent,
      })),
    });
  }
  expect(waited).toEqual(scenario.commands.map((_, index) => 111 + index));
  expect(closed).toEqual(scenario.pipe ? [123, 456] : scenario.fileCursor ? [123] : []);
  expect(killed).toEqual(scenario.pipe === "signal" ? [111] : []);
  expect(output).toEqual((scenario.pipe === "input" ? [scenario.input ?? ""] : []).concat(["external-root-ok\n"]));
});

test("pipeline fixture starts every real child before blocking on the first job", () => {
  const scenario = bunRuntimeProcScenarios.find(item => item.name === "pipeline-merged")!;
  let memory: WebAssembly.Memory;
  let spawned = 0;
  const instance = new WebAssembly.Instance(new WebAssembly.Module(bunRuntimeProcFixture(scenario)), {
    runtime_proc: {
      spawn() { return ++spawned; }, job_of(pid: number) { return pid; },
      wait_job(_job: number, _flags: number, pointer: number) { expect(spawned).toBe(2); new DataView(memory.buffer).setInt32(pointer, 0, true); return 0; },
      write(_fd: number, _pointer: number, length: number) { return length; },
      read() { throw new Error("pipeline root must not buffer its children"); }, poll() { return 0; }, kill_job() { throw new Error("pipeline must not kill its children"); },
      pipe(pointer: number) { const view = new DataView(memory.buffer); view.setInt32(pointer, 7, true); view.setInt32(pointer + 4, 8, true); return 0; },
    }, wasi_snapshot_preview1: { fd_close() { return 0; }, proc_exit(code: number) { throw new Error(`stage ${code}`); } },
  });
  memory = instance.exports.memory as WebAssembly.Memory;
  (instance.exports._start as () => void)();
});

test("actual Bun relocated-root acceptance covers inherited fd3, prefixes, holes and a sparse high fd with exit0", () => {
  const scenarios = bunRuntimeProcScenarios.filter(item => item.name.startsWith("preopen-inherited-"));
  expect(scenarios.map(item => item.name)).toEqual(["preopen-inherited-3", "preopen-inherited-3-4", "preopen-inherited-3-5", "preopen-inherited-3-1000000"]);
  for (const scenario of scenarios) {
    expect(scenario.stdout).toBe("ROOT_PREOPEN_OK\nexternal-root-ok\n");
    expect(scenario.commands[0]!.status ?? 0).toBe(0);
  }
});

test("actual Bun fd4-read/fd3-write acceptance is enabled with exit0 rather than an EBADF allowance", () => {
  const scenario = bunRuntimeProcScenarios.find(item => item.name === "preopen-blocks-fd4-read-fd3-write")!;
  expect(scenario.commands[0]!.status ?? 0).toBe(0);
  expect(scenario.stdout).toBe("FD3:cursor\nexternal-root-ok\n");
});

for (const control of [
  { returned: -27, kind: 0, value: 0 },
  { returned: -12, kind: 2, value: 44 },
  { returned: 0, kind: 0, value: 0 },
]) {
  test(`external root retains wait_job failure and diagnostic values (${control.returned})`, () => {
    let instance: WebAssembly.Instance;
    let stdout = "", stderr = "", status: number | undefined;
    const stopped = new Error("fixture proc_exit");
    const module = new WebAssembly.Module(bunRuntimeProcFixture({
      name: "wait-diagnostic-control", commands: [{ source: "" }], stdout: "external-root-ok\n",
    }));
    instance = new WebAssembly.Instance(module, {
      runtime_proc: {
        spawn: () => 2,
        job_of: () => 3,
        wait_job: (_job: number, _flags: number, pointer: number) => {
          const view = new DataView((instance.exports.memory as WebAssembly.Memory).buffer);
          view.setUint32(pointer, control.kind, true);
          view.setInt32(pointer + 4, control.value, true);
          return control.returned;
        },
        write: (fd: number, pointer: number, length: number) => {
          const bytes = new Uint8Array((instance.exports.memory as WebAssembly.Memory).buffer, pointer, length);
          if (fd === 2) stderr += new TextDecoder().decode(bytes);
          else stdout += new TextDecoder().decode(bytes);
          return length;
        },
        pipe: () => 0, read: () => -6, poll: () => 0, kill_job: () => 0,
      },
      wasi_snapshot_preview1: {
        fd_close: () => 0,
        proc_exit: (code: number) => { status = code; throw stopped; },
      },
    });
    try { (instance.exports._start as () => void)(); }
    catch (error) { expect(error).toBe(stopped); }
    if (control.returned === 0) {
      expect(status).toBeUndefined();
      expect(stdout).toBe("external-root-ok\n");
      expect(stderr).toBe("");
    } else {
      expect(status).toBe(205);
      expect(stdout).toBe("");
      expect(stderr).toBe(`runtime-proc wait_job errno=${String(-control.returned).padStart(10, "0")} result-kind=${String(control.kind).padStart(10, "0")} result-value=${String(control.value).padStart(10, "0")}\n`);
    }
  });
}
