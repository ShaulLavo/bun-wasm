import { expect, test } from "bun:test";
import type { SpawnRequest } from "waffle/proc/types";
import { bunRuntimeProcFixture, bunRuntimeProcPending, bunRuntimeProcScenarios } from "./bun-runtime-proc-fixtures";

for (const scenario of bunRuntimeProcScenarios) test(`external generic root fixture ${scenario.name} retains requests, fds and blocking job status checks`, () => {
  const bytes = bunRuntimeProcFixture(scenario);
  expect(WebAssembly.validate(bytes)).toBe(true);
  const module = new WebAssembly.Module(bytes);
  expect(WebAssembly.Module.imports(module).filter(item => item.module === "runtime_proc").map(item => item.name))
    .toEqual(["spawn", "job_of", "wait_job", "write", "pipe"]);
  let memory: WebAssembly.Memory;
  const requests: SpawnRequest[] = [], waited: number[] = [], closed: number[] = [];
  const output: string[] = [];
  const instance = new WebAssembly.Instance(module, {
    runtime_proc: {
      spawn(pointer: number, length: number) {
        const spec: SpawnRequest = JSON.parse(new TextDecoder().decode(new Uint8Array(memory.buffer, pointer, length)));
        requests.push(spec); return requests.length + 10;
      },
      job_of(pid: number) { return pid + 100; },
      wait_job(job: number, flags: number, pointer: number) {
        expect(flags).toBe(0); waited.push(job);
        new DataView(memory.buffer).setInt32(pointer, scenario.commands[waited.length - 1]!.status ?? 0, true);
        return 0;
      },
      write(_fd: number, pointer: number, length: number) {
        output.push(new TextDecoder().decode(new Uint8Array(memory.buffer, pointer, length))); return length;
      },
      pipe(pointer: number) { const view = new DataView(memory.buffer); view.setInt32(pointer, 123, true); view.setInt32(pointer + 4, 456, true); return 0; },
    },
    wasi_snapshot_preview1: {
      fd_close(fd: number) { closed.push(fd); return 0; },
      proc_exit(code: number) { throw new Error(`external root failed stage ${code}`); },
    },
  });
  memory = instance.exports.memory as WebAssembly.Memory;
  (instance.exports._start as () => void)();
  expect(requests).toHaveLength(scenario.commands.length);
  for (const [index, request] of requests.entries()) {
    const command = scenario.commands[index]!;
    expect(request).toEqual({ executable: command.executable ?? "bun", argv: ["bun", "-e", command.source],
      env: { PWD: "/home/user" }, cwd: "/home/user", job: 0,
      fds: (command.fds ?? [{ child: 0, parent: 0 }, { child: 1, parent: 1 }, { child: 2, parent: 2 }]).map(binding => ({
        child: binding.child, parent: binding.parent === "reader" ? 123 : binding.parent === "writer" ? 456 : binding.parent,
      })),
    });
  }
  expect(waited).toEqual(scenario.commands.map((_, index) => 111 + index));
  expect(closed).toEqual(scenario.pipe ? [123, 456] : []);
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
      pipe(pointer: number) { const view = new DataView(memory.buffer); view.setInt32(pointer, 7, true); view.setInt32(pointer + 4, 8, true); return 0; },
    }, wasi_snapshot_preview1: { fd_close() { return 0; }, proc_exit(code: number) { throw new Error(`stage ${code}`); } },
  });
  memory = instance.exports.memory as WebAssembly.Memory;
  (instance.exports._start as () => void)();
});

for (const pending of bunRuntimeProcPending) test.todo(pending);
