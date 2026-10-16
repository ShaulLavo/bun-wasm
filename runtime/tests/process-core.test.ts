import { expect, test } from "bun:test";
import { ExecutableRegistry, FirstSpawnStub, ProcessIdentityAllocator, ProcessSupervisor, Signal, type ProcessContext, type SpawnRequest } from "../proc";

const module = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const request = (overrides: Partial<SpawnRequest> = {}): SpawnRequest => ({
  executable: "fixture", argv: ["fixture"], env: {}, cwd: "/", job: 0, fds: [], ...overrides,
});
function fixture() {
  const registry = new ExecutableRegistry();
  registry.register("fixture", { module, adapter: "preview1" });
  const contexts = new Map<number, ProcessContext>();
  const terminated: number[] = [];
  const supervisor = new ProcessSupervisor({ registry, launch(context) {
    contexts.set(context.pid, context);
    return { terminate() { terminated.push(context.pid); } };
  } });
  const root = supervisor.createRoot();
  return { registry, supervisor, root, contexts, terminated };
}

test("shared allocators reserve independent pid and job number spaces without reuse", () => {
  const first = new ProcessIdentityAllocator();
  const second = new ProcessIdentityAllocator(first.buffer);
  expect(first.pid()).toBe(1);
  expect(second.pid()).toBe(2);
  expect(second.job()).toBe(1);
  expect(first.pid()).toBe(3);
  expect(first.job()).toBe(2);
});

test("registry shares concurrent compilation by loader, not executable name or adapter", async () => {
  const registry = new ExecutableRegistry();
  let loads = 0;
  const compilation = deferred<WebAssembly.Module>();
  const load = () => { loads++; return compilation.promise; };
  registry.register("a", { module: load, adapter: "preview1" });
  registry.register("b", { module: load, adapter: "other" });
  const a = registry.resolve("a"), b = registry.resolve("b");
  compilation.resolve(module);
  expect((await a).module).toBe(module);
  expect((await b).adapter).toBe("other");
  expect(loads).toBe(1);
});

test("first-spawn returns and retains arbitrary descriptor references before activation", async () => {
  const { supervisor, root, contexts } = fixture();
  let closed = 0;
  const descriptors = supervisor.get(root)!.descriptors;
  const fd = descriptors.open({ kind: "directory", handle: 42 }, 7n, 3n, () => closed++);
  const activation = deferred<ProcessSupervisor>();
  let activations = 0;
  const stub = new FirstSpawnStub({
    reserve: (parent, spec) => supervisor.reserveSpawn(parent, spec),
    activate: () => { activations++; return activation.promise; },
    fail: (pid, error) => supervisor.failStart(pid, error),
  });
  const pid = stub.spawn(root, request({ fds: [{ child: 9, parent: fd }] }));
  descriptors.close(fd);
  expect(supervisor.wait(root, pid)).toBeNull();
  expect(closed).toBe(0);
  expect(contexts.size).toBe(0);
  let unrelatedTask = false;
  await new Promise<void>(resolve => setTimeout(() => { unrelatedTask = true; resolve(); }, 0));
  expect(unrelatedTask).toBe(true);
  expect(contexts.size).toBe(0);
  const sibling = stub.spawn(root, request());
  activation.resolve(supervisor);
  await stub.activated();
  await supervisor.start(pid);
  await supervisor.start(sibling);
  expect(activations).toBe(1);
  expect(contexts.get(pid)!.descriptors.get(9)!.resource).toEqual({ kind: "directory", handle: 42 });
  contexts.get(pid)!.exit(3);
  contexts.get(sibling)!.exit(0);
  expect(await supervisor.waitForExit(root, pid)).toEqual({ kind: "exited", code: 3, status: 3 });
  expect(closed).toBe(1);
});

test("activation rejection becomes exit 126 for every reserved child and releases fds", async () => {
  const { supervisor, root } = fixture();
  const stub = new FirstSpawnStub({
    reserve: (parent, spec) => supervisor.reserveSpawn(parent, spec),
    activate: async () => { throw new Error("chunk unavailable"); },
    fail: (pid, error) => supervisor.failStart(pid, error),
  });
  const a = stub.spawn(root, request()), b = stub.spawn(root, request());
  expect(await supervisor.waitForExit(root, a)).toEqual({ kind: "exited", code: 126, status: 126 });
  expect(await supervisor.waitForExit(root, b)).toEqual({ kind: "exited", code: 126, status: 126 });
});

test("missing and unrunnable executables report 127/126 via wait and child-exit events", async () => {
  const { registry, supervisor, root } = fixture();
  registry.register("bad", { module: async () => { throw new Error("invalid wasm"); }, adapter: "preview1" });
  const events: number[] = [];
  const unsubscribe = supervisor.onChildExit(event => events.push(event.pid));
  const missing = supervisor.spawn(root, request({ executable: "missing" }));
  const bad = supervisor.spawn(root, request({ executable: "bad" }));
  expect(await supervisor.waitForExit(root, missing)).toEqual({ kind: "exited", code: 127, status: 127 });
  expect(await supervisor.waitForExit(root, bad)).toEqual({ kind: "exited", code: 126, status: 126 });
  expect(events.sort()).toEqual([missing, bad].sort());
  expect(supervisor.wait(root, missing)).toEqual({ kind: "exited", code: 127, status: 127 });
  supervisor.reap(root, missing);
  expect(() => supervisor.wait(root, missing)).toThrow();
  unsubscribe();
});

test("spawn snapshots request data and atomically rejects bad descriptor bindings", async () => {
  const { supervisor, root, contexts } = fixture();
  const descriptors = supervisor.get(root)!.descriptors;
  const fd = descriptors.open({ kind: "directory", handle: 1 }, 7n, 3n);
  const description = descriptors.get(fd)!.description;
  expect(() => supervisor.spawn(root, request({ fds: [{ child: 3, parent: fd }, { child: 4, parent: 999 }] }))).toThrow();
  expect(description.references).toBe(1);
  expect(() => supervisor.spawn(root, request({ fds: [{ child: 3, parent: fd }, { child: 3, parent: fd }] }))).toThrow();
  expect(description.references).toBe(1);
  const spec = request({ argv: ["original"], env: { A: "original" } });
  const pid = supervisor.spawn(root, spec);
  spec.argv[0] = "changed";
  spec.env.A = "changed";
  await supervisor.start(pid);
  expect(contexts.get(pid)!.request.argv).toEqual(["original"]);
  expect(contexts.get(pid)!.request.env).toEqual({ A: "original" });
  contexts.get(pid)!.exit(0);
  descriptors.dispose();
});

test("kill records signal, interrupts, revokes and publishes logical exit before teardown", async () => {
  const { supervisor, root, contexts, terminated } = fixture();
  const pid = supervisor.spawn(root, request());
  await supervisor.start(pid);
  const context = contexts.get(pid)!;
  const order: string[] = [];
  context.registerRevocation(() => {
    expect(Atomics.load(context.interrupt, 0)).toBe(Signal.SIGINT);
    expect(Atomics.load(context.requestedSignal, 0)).toBe(Signal.SIGINT);
    order.push("revoked");
  });
  supervisor.onChildExit(event => { if (event.pid === pid) order.push("exit"); });
  supervisor.kill(pid, Signal.SIGINT);
  expect(order).toEqual([]);
  expect(supervisor.wait(root, pid)).toBeNull();
  context.defaultSignal(Signal.SIGINT);
  expect(order).toEqual(["revoked", "exit"]);
  expect(terminated).toEqual([pid]);
  expect(supervisor.wait(root, pid)).toEqual({ kind: "signaled", code: Signal.SIGINT, status: 130 });
  expect(Atomics.exchange(context.interrupt, 0, 0)).toBe(Signal.SIGINT);
  expect(Atomics.load(context.requestedSignal, 0)).toBe(Signal.SIGINT);
  context.exit(0); // Late zombie messages cannot change recorded cancellation.
  expect(supervisor.wait(root, pid)).toEqual({ kind: "signaled", code: Signal.SIGINT, status: 130 });
});

test("killJob includes same-job descendants but preserves explicit background jobs", async () => {
  const { supervisor, root, contexts } = fixture();
  const foreground = supervisor.spawn(root, request());
  const background = supervisor.spawn(root, request({ job: -1 }));
  await supervisor.start(foreground);
  await supervisor.start(background);
  const child = supervisor.spawn(foreground, request({ job: supervisor.jobOf(foreground) }));
  await supervisor.start(child);
  const descendant = supervisor.spawn(child, request({ job: -1 }));
  await supervisor.start(descendant);
  expect(supervisor.jobOf(child)).toBe(supervisor.jobOf(foreground));
  expect(supervisor.jobOf(descendant)).not.toBe(supervisor.jobOf(foreground));
  expect(supervisor.job(supervisor.jobOf(background))!.foreground).toBe(false);
  supervisor.killJob(supervisor.jobOf(foreground), Signal.SIGTERM);
  for (const pid of [foreground, child]) {
    contexts.get(pid)!.defaultSignal(Signal.SIGTERM);
    expect(supervisor.get(pid)!.result).toEqual({ kind: "signaled", code: Signal.SIGTERM, status: 143 });
  }
  expect(Atomics.load(contexts.get(descendant)!.interrupt, 0)).toBe(0);
  expect(supervisor.wait(child, descendant)).toBeNull();
  contexts.get(descendant)!.exit(0);
  expect(supervisor.wait(root, background)).toBeNull();
  contexts.get(background)!.exit(11);
  expect(await supervisor.waitForExit(root, background)).toEqual({ kind: "exited", code: 11, status: 11 });
});

test("pending processes killed before module activation never launch", async () => {
  const { registry, supervisor, root, contexts } = fixture();
  const activation = deferred<WebAssembly.Module>();
  registry.register("slow", { module: () => activation.promise, adapter: "preview1" });
  const pid = supervisor.spawn(root, request({ executable: "slow" }));
  const starting = supervisor.start(pid);
  supervisor.kill(pid, Signal.SIGKILL);
  activation.resolve(module);
  await starting;
  expect(contexts.has(pid)).toBe(false);
  expect(supervisor.wait(root, pid)).toEqual({ kind: "signaled", code: Signal.SIGKILL, status: 137 });
});

test("late asynchronous launch handles are terminated and late revocation hooks run immediately", async () => {
  const registry = new ExecutableRegistry();
  registry.register("fixture", { module, adapter: "preview1" });
  const handle = deferred<{ terminate(): void }>();
  let context!: ProcessContext, terminated = 0, revoked = 0;
  const supervisor = new ProcessSupervisor({ registry, launch(value) { context = value; return handle.promise; } });
  const root = supervisor.createRoot();
  const pid = supervisor.spawn(root, request());
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  supervisor.kill(pid, Signal.SIGPIPE);
  context.defaultSignal(Signal.SIGPIPE);
  context.registerRevocation(() => revoked++);
  handle.resolve({ terminate() { terminated++; } });
  await supervisor.start(pid);
  expect(terminated).toBe(1);
  expect(revoked).toBe(1);
  expect(supervisor.wait(root, pid)).toEqual({ kind: "signaled", code: Signal.SIGPIPE, status: 141 });
});

test("adopted guest pid, job and signal buffers remain the authoritative identities", async () => {
  const { supervisor, contexts } = fixture();
  const root = supervisor.createRoot({ pid: 40, job: 20 });
  const interrupt = new Int32Array(new SharedArrayBuffer(4));
  const requestedSignal = new Int32Array(new SharedArrayBuffer(4));
  const pid = supervisor.reserveSpawn(root, request({ job: 20 }), { pid: 41, job: 20, interrupt, requestedSignal });
  expect(pid).toBe(41);
  await supervisor.start(pid);
  expect(contexts.get(pid)!.interrupt).toBe(interrupt);
  supervisor.kill(pid, Signal.SIGTERM);
  expect(Atomics.load(requestedSignal, 0)).toBe(Signal.SIGTERM);
  expect(supervisor.jobOf(pid)).toBe(20);
  expect(() => supervisor.reserveSpawn(root, request(), { pid: 41 })).toThrow();
});

test("revocation exceptions do not strand descriptors, waiters or other job members", async () => {
  const { supervisor, root, contexts, terminated } = fixture();
  const a = supervisor.spawn(root, request());
  const b = supervisor.spawn(root, request({ job: supervisor.jobOf(a) }));
  await supervisor.start(a);
  await supervisor.start(b);
  contexts.get(a)!.registerRevocation(() => { throw new Error("broken resource"); });
  let secondHook = false;
  contexts.get(a)!.registerRevocation(() => { secondHook = true; });
  supervisor.killJob(supervisor.jobOf(a), Signal.SIGKILL);
  expect(secondHook).toBe(true);
  expect(await supervisor.waitForExit(root, a)).toEqual({ kind: "signaled", code: Signal.SIGKILL, status: 137 });
  expect(await supervisor.waitForExit(root, b)).toEqual({ kind: "signaled", code: Signal.SIGKILL, status: 137 });
  expect(terminated.sort()).toEqual([a, b].sort());
});

test("handled SIGINT may exit zero and pending requested signal never reclassifies a later trap", async () => {
  const { supervisor, root, contexts, terminated } = fixture();
  const handled = supervisor.spawn(root, request());
  const crashed = supervisor.spawn(root, request());
  await supervisor.start(handled);
  await supervisor.start(crashed);
  supervisor.kill(handled, Signal.SIGINT);
  expect(Atomics.exchange(contexts.get(handled)!.interrupt, 0, 0)).toBe(Signal.SIGINT);
  expect(supervisor.wait(root, handled)).toBeNull();
  expect(terminated).toEqual([]);
  contexts.get(handled)!.exit(0);
  expect(supervisor.wait(root, handled)).toEqual({ kind: "exited", code: 0, status: 0 });
  supervisor.kill(crashed, Signal.SIGINT);
  Atomics.exchange(contexts.get(crashed)!.interrupt, 0, 0);
  contexts.get(crashed)!.fail(new WebAssembly.RuntimeError("unrelated trap after handling"));
  expect(supervisor.wait(root, crashed)).toEqual({ kind: "exited", code: 126, status: 126 });
});

test("SIGKILL during a handler overrides later handled exits and default actions", async () => {
  const { supervisor, root, contexts } = fixture();
  const pid = supervisor.spawn(root, request());
  await supervisor.start(pid);
  supervisor.kill(pid, Signal.SIGINT);
  Atomics.exchange(contexts.get(pid)!.interrupt, 0, 0);
  supervisor.kill(pid, Signal.SIGKILL);
  contexts.get(pid)!.exit(0);
  contexts.get(pid)!.defaultSignal(Signal.SIGINT);
  expect(supervisor.wait(root, pid)).toEqual({ kind: "signaled", code: 9, status: 137 });
});

test("handled EPIPE keeps its exit code but the explicit default SIGPIPE action reports141", async () => {
  const { supervisor, root, contexts } = fixture();
  const handled = supervisor.spawn(root, request()), unhandled = supervisor.spawn(root, request());
  await supervisor.start(handled);
  await supervisor.start(unhandled);
  contexts.get(handled)!.exit(23);
  contexts.get(unhandled)!.defaultSignal(Signal.SIGPIPE);
  expect(supervisor.wait(root, handled)).toEqual({ kind: "exited", code: 23, status: 23 });
  expect(supervisor.wait(root, unhandled)).toEqual({ kind: "signaled", code: 13, status: 141 });
});

test("reaping an ancestor preserves descendant job discovery and released pids cannot be reused", async () => {
  const { supervisor, root, contexts } = fixture();
  const a = supervisor.spawn(root, request());
  await supervisor.start(a);
  const descendant = supervisor.spawn(a, request({ job: supervisor.jobOf(a) }));
  await supervisor.start(descendant);
  const job = supervisor.jobOf(a);
  contexts.get(a)!.exit(0);
  supervisor.reap(root, a);
  supervisor.killJob(job, Signal.SIGKILL);
  expect(supervisor.get(descendant)!.result!.status).toBe(137);
  expect(() => supervisor.reserveSpawn(root, request(), { pid: a })).toThrow();
});

test("descriptor cleanup exceptions still drain all references and dispose cancels pending starts", async () => {
  const { supervisor, root } = fixture();
  const descriptors = supervisor.get(root)!.descriptors;
  let releases = 0;
  const a = descriptors.open({ kind: "directory", handle: 1 }, 1n, 1n, () => { releases++; throw new Error("close failed"); });
  const b = descriptors.open({ kind: "directory", handle: 2 }, 1n, 1n, () => { releases++; });
  const pid = supervisor.reserveSpawn(root, request({ fds: [{ child: 3, parent: a }, { child: 4, parent: b }] }));
  descriptors.close(a);
  descriptors.close(b);
  const waiting = supervisor.waitForExit(root, pid);
  supervisor.dispose();
  expect((await waiting).status).toBe(137);
  expect(releases).toBe(2);
  expect(() => supervisor.spawn(root, request())).toThrow();
  supervisor.dispose();
});

test("job teardown tolerates exit observers reaping another target synchronously", async () => {
  const { supervisor, root } = fixture();
  const a = supervisor.spawn(root, request());
  const b = supervisor.spawn(root, request({ job: supervisor.jobOf(a) }));
  await supervisor.start(a);
  await supervisor.start(b);
  supervisor.onChildExit(event => {
    if (event.pid !== a) return;
    supervisor.kill(b, Signal.SIGKILL);
    supervisor.reap(root, b);
  });
  expect(() => supervisor.killJob(supervisor.jobOf(a), Signal.SIGKILL)).not.toThrow();
  supervisor.dispose();
});

test("identity exhaustion never wraps to a reused or negative pid", () => {
  const allocator = new ProcessIdentityAllocator();
  allocator.observePid(0x7ffffffe);
  expect(allocator.pid()).toBe(0x7fffffff);
  expect(() => allocator.pid()).toThrow("exhausted");
  expect(allocator.job()).toBe(1);
});

test("killJob records every member before any teardown callback can spawn more descendants", async () => {
  const { supervisor, root, contexts } = fixture();
  const a = supervisor.spawn(root, request());
  const b = supervisor.spawn(root, request({ job: supervisor.jobOf(a) }));
  await supervisor.start(a);
  await supervisor.start(b);
  let rejected = false;
  contexts.get(a)!.registerRevocation(() => {
    expect(Atomics.load(contexts.get(b)!.requestedSignal, 0)).toBe(Signal.SIGKILL);
    try { supervisor.spawn(b, request()); }
    catch { rejected = true; }
  });
  supervisor.killJob(supervisor.jobOf(a), Signal.SIGKILL);
  expect(rejected).toBe(true);
});

test("reaping the final member releases job metadata without affecting background descendants", async () => {
  const { supervisor, root, contexts } = fixture();
  const a = supervisor.spawn(root, request());
  await supervisor.start(a);
  const job = supervisor.jobOf(a);
  const b = supervisor.spawn(a, request({ job: -1 }));
  await supervisor.start(b);
  const descendantJob = supervisor.jobOf(b);
  contexts.get(a)!.exit(0);
  supervisor.reap(root, a);
  expect(supervisor.job(job)).toBeUndefined();
  expect(supervisor.job(descendantJob)).toBeDefined();
  contexts.get(b)!.exit(0);
  supervisor.reap(a, b);
  expect(supervisor.job(job)).toBeUndefined();
  expect(supervisor.job(descendantJob)).toBeUndefined();
});

test("an already recorded job SIGKILL cannot be replaced by a reentrant handled exit", async () => {
  const { supervisor, root, contexts } = fixture();
  const a = supervisor.spawn(root, request());
  const b = supervisor.spawn(root, request({ job: supervisor.jobOf(a) }));
  await supervisor.start(a);
  await supervisor.start(b);
  contexts.get(a)!.registerRevocation(() => {
    supervisor.kill(b, Signal.SIGINT);
    contexts.get(b)!.exit(0);
  });
  supervisor.killJob(supervisor.jobOf(a), Signal.SIGKILL);
  expect(supervisor.wait(root, b)).toEqual({ kind: "signaled", code: 9, status: 137 });
  expect(Atomics.load(contexts.get(b)!.interrupt, 0)).toBe(9);
});

test("explicit adopted job ids cannot be reused after their final member is reaped", async () => {
  const { supervisor, root, contexts } = fixture();
  const pid = supervisor.spawn(root, request());
  const job = supervisor.jobOf(pid);
  await supervisor.start(pid);
  contexts.get(pid)!.exit(0);
  supervisor.reap(root, pid);
  expect(() => supervisor.reserveSpawn(root, request(), { job })).toThrow();
});

test("a guest-side SIGKILL recorded before a delayed broker notification wins an exit ACK", async () => {
  const { supervisor, root, contexts } = fixture();
  const pid = supervisor.spawn(root, request());
  await supervisor.start(pid);
  const context = contexts.get(pid)!;
  Atomics.store(context.requestedSignal, 0, Signal.SIGKILL);
  Atomics.store(context.interrupt, 0, Signal.SIGKILL);
  context.exit(0);
  expect(supervisor.wait(root, pid)).toEqual({ kind: "signaled", code: 9, status: 137 });
});

test("observing an already delivered signal records it without publishing a second interrupt", async () => {
  const { supervisor, root, contexts } = fixture();
  const pid = supervisor.spawn(root, request());
  await supervisor.start(pid);
  const context = contexts.get(pid)!;
  for (let request = 0; request < 2; request++) {
    Atomics.store(context.requestedSignal, 0, Signal.SIGINT);
    Atomics.store(context.interrupt, 0, Signal.SIGINT);
    expect(Atomics.exchange(context.interrupt, 0, 0)).toBe(Signal.SIGINT);
    supervisor.observeSignal(pid, Signal.SIGINT);
    expect(supervisor.get(pid)!.signal).toBe(Signal.SIGINT);
    expect(Atomics.load(context.interrupt, 0)).toBe(0);
  }
  context.exit(0);
  expect(supervisor.wait(root, pid)!.status).toBe(0);
});

test("observing an already published SIGKILL still revokes and completes the process", async () => {
  const { supervisor, root, contexts } = fixture();
  const pid = supervisor.spawn(root, request());
  await supervisor.start(pid);
  Atomics.store(contexts.get(pid)!.requestedSignal, 0, Signal.SIGKILL);
  supervisor.observeSignal(pid, Signal.SIGKILL);
  expect(supervisor.wait(root, pid)!.status).toBe(137);
});

for (const delivery of ["kill", "killJob", "defaultSignal", "observeSignal"] as const) {
  test(`${delivery} cannot downgrade a guest SIGKILL published before host observation`, async () => {
    const { supervisor, root, contexts } = fixture();
    const pid = supervisor.spawn(root, request());
    await supervisor.start(pid);
    const context = contexts.get(pid)!;
    Atomics.store(context.requestedSignal, 0, Signal.SIGKILL);
    Atomics.store(context.interrupt, 0, Signal.SIGKILL);
    if (delivery === "killJob") supervisor.killJob(supervisor.jobOf(pid), Signal.SIGTERM);
    else supervisor[delivery](pid, Signal.SIGINT);
    expect(supervisor.wait(root, pid)).toEqual({ kind: "signaled", code: 9, status: 137 });
    expect(Atomics.load(context.requestedSignal, 0)).toBe(9);
    expect(Atomics.load(context.interrupt, 0)).toBe(9);
    context.exit(0);
    expect(supervisor.wait(root, pid)!.status).toBe(137);
  });
}

for (const word of ["requestedSignal", "interrupt"] as const) {
  test(`SIGKILL winning a ${word} compare-exchange race cannot be overwritten`, async () => {
    const { supervisor, root, contexts } = fixture();
    const pid = supervisor.spawn(root, request());
    await supervisor.start(pid);
    const context = contexts.get(pid)!;
    const original = Atomics.compareExchange;
    let raced = false;
    Atomics.compareExchange = ((array: Int32Array, index: number, expected: number, replacement: number) => {
      if (!raced && array === context[word]) {
        raced = true;
        Atomics.store(context.requestedSignal, 0, 9);
        Atomics.store(context.interrupt, 0, 9);
      }
      return original(array, index, expected, replacement);
    }) as typeof Atomics.compareExchange;
    try { supervisor.kill(pid, Signal.SIGINT); }
    finally { Atomics.compareExchange = original; }
    expect(raced).toBe(true);
    expect(supervisor.wait(root, pid)).toEqual({ kind: "signaled", code: 9, status: 137 });
    expect(Atomics.load(context.requestedSignal, 0)).toBe(9);
    expect(Atomics.load(context.interrupt, 0)).toBe(9);
  });
}
