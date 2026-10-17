import { expect, test } from "bun:test";
import { runtimeProcFixture } from "./runtime-proc-fixtures";

test("artifact-free process guest has only generic ABI and preview1 imports", () => {
  const bytes = runtimeProcFixture();
  expect(WebAssembly.validate(bytes)).toBe(true);
  const imports = WebAssembly.Module.imports(new WebAssembly.Module(bytes));
  expect(imports.filter(item => item.module === "runtime_proc").map(item => item.name))
    .toEqual(["read", "write", "pipe", "dup", "spawn", "wait", "job_of", "poll"]);
  expect(imports.every(item => item.module === "runtime_proc" || item.module === "wasi_snapshot_preview1")).toBe(true);
});

test("parent fixture builds dynamic descriptor JSON and checks every guest sequence stage", () => {
  let memory: WebAssembly.Memory;
  let pipe = 0, reads = 0, waits = 0, polls = 0;
  const closed: number[] = [], writes: string[] = [];
  let spawned: unknown;
  const instance = new WebAssembly.Instance(new WebAssembly.Module(runtimeProcFixture()), {
    runtime_proc: {
      read(_fd: number, ptr: number, length: number) {
        reads++;
        if (reads === 1) return -6;
        const bytes = new TextEncoder().encode(reads === 2 ? "R" : reads === 3 ? "pong" : "");
        expect(length).toBeGreaterThanOrEqual(bytes.length);
        new Uint8Array(memory.buffer, ptr, bytes.length).set(bytes);
        return bytes.length;
      },
      write(_fd: number, ptr: number, length: number) { writes.push(new TextDecoder().decode(new Uint8Array(memory.buffer, ptr, length))); return length; },
      pipe(ptr: number) { const view = new DataView(memory.buffer); view.setUint32(ptr, 123 + pipe * 2, true); view.setUint32(ptr + 4, 124 + pipe++ * 2, true); return 0; },
      dup(fd: number) { return fd + 1000; },
      spawn(ptr: number, length: number) { spawned = JSON.parse(new TextDecoder().decode(new Uint8Array(memory.buffer, ptr, length))); return 2; },
      wait(_pid: number, ptr: number) { if (++waits === 1) return -6; const view = new DataView(memory.buffer); view.setUint32(ptr, 0, true); view.setInt32(ptr + 4, 23, true); return 0; },
      job_of() { return 1; },
      poll(ptr: number, count: number, timeout: number, out: number) {
        expect(count).toBe(1); expect(timeout).toBe(5000); polls++;
        const view = new DataView(memory.buffer);
        view.setBigUint64(out, view.getBigUint64(ptr + 8, true), true);
        view.setUint32(out + 8, view.getUint32(ptr, true), true);
        view.setUint32(out + 12, polls === 3 ? 1 : 0, true);
        return 1;
      },
    },
    wasi_snapshot_preview1: {
      args_sizes_get(ptr: number) { new DataView(memory.buffer).setUint32(ptr, 2, true); return 0; },
      fd_close(fd: number) { closed.push(fd); return 0; },
      proc_exit(code: number) { throw new Error(`fixture exited at stage ${code}`); },
    },
  });
  memory = instance.exports.memory as WebAssembly.Memory;
  (instance.exports._start as () => void)();
  expect(spawned).toEqual({ executable: "bun", argv: ["abi-child"], env: { PWD: "/" }, cwd: "/", job: 1,
    fds: [{ child: 0, parent: 123 }, { child: 1, parent: 126 }, { child: 10, parent: 126 }, { child: 2, parent: 2 }, { child: 11, parent: 1 }] });
  expect(closed).toEqual([124, 125, 123, 126, 1124, 1125]);
  expect(writes).toEqual(["ping", "runtime-proc-ok\n"]);
  expect(reads).toBe(4); expect(waits).toBe(2); expect(polls).toBe(4);
});

test("child fixture closes its inherited alias, waits for stdin EOF and exits with status 23", () => {
  let memory: WebAssembly.Memory;
  let reads = 0, polls = 0;
  const closed: number[] = [], writes: string[] = [];
  class Exit extends Error { constructor(readonly code: number) { super(`exit ${code}`); } }
  const unused = () => { throw new Error("child called a parent-only import"); };
  const instance = new WebAssembly.Instance(new WebAssembly.Module(runtimeProcFixture()), {
    runtime_proc: {
      read(fd: number, ptr: number, length: number) {
        expect(fd).toBe(0); reads++;
        if (reads === 2) return 0;
        expect(length).toBe(4); new Uint8Array(memory.buffer, ptr, 4).set(new TextEncoder().encode("ping")); return 4;
      },
      write(fd: number, ptr: number, length: number) {
        expect(fd).toBe(writes.length < 2 ? 10 : writes.length === 2 ? 11 : 2);
        writes.push(new TextDecoder().decode(new Uint8Array(memory.buffer, ptr, length))); return length;
      },
      pipe: unused, dup: unused, spawn: unused, wait: unused, job_of: unused,
      poll(ptr: number, count: number, timeout: number, out: number) {
        expect(count).toBe(1); expect(timeout).toBe(5000); polls++;
        const view = new DataView(memory.buffer);
        view.setBigUint64(out, view.getBigUint64(ptr + 8, true), true);
        view.setUint32(out + 8, view.getUint32(ptr, true), true);
        view.setUint32(out + 12, polls === 2 ? 1 : 0, true); return 1;
      },
    },
    wasi_snapshot_preview1: {
      args_sizes_get(ptr: number) { new DataView(memory.buffer).setUint32(ptr, 1, true); return 0; },
      fd_close(fd: number) { closed.push(fd); return 0; }, proc_exit(code: number) { throw new Exit(code); },
    },
  });
  memory = instance.exports.memory as WebAssembly.Memory;
  try { (instance.exports._start as () => void)(); throw new Error("child returned instead of calling proc_exit"); }
  catch (error) { expect(error).toBeInstanceOf(Exit); expect((error as Exit).code).toBe(23); }
  expect(writes).toEqual(["R", "pong", "child-stdout\n", "child-stderr\n"]); expect(closed).toEqual([1, 0, 10, 11, 2]);
  expect(reads).toBe(2); expect(polls).toBe(2);
});
