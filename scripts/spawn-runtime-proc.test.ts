import { expect, test } from "bun:test";
import { service, load, type ProcessExit } from "./spawn-runtime-proc-fixture.ts";
const ENOENT = -44;
const EAGAIN = -6;

function decode(subscriptions: Uint8Array) {
  const view = new DataView(subscriptions.buffer, subscriptions.byteOffset, subscriptions.byteLength);
  return Array.from({ length: subscriptions.length / 16 }, (_, i) => [view.getUint32(i * 16, true), view.getUint32(i * 16 + 4, true)]);
}

test("pipes bind to child descriptors and the parent drops its child ends", async () => {
  const fake = service();
  const { module, pump } = load(fake);
  const child = module.spawn(["bun", "-e", "1"], { stdin: "pipe", stdout: "pipe", stderr: "inherit", env: { A: "1" }, cwd: "/tmp" });
  const record = fake.children.get(child.pid)!;
  expect(record.request).toMatchObject({ executable: "/bin/bun", argv: ["bun", "-e", "1"], env: { A: "1" }, cwd: "/tmp", job: 3 });
  const bindings = record.request.fds;
  expect(bindings.map((b: any) => b.child)).toEqual([0, 1, 2]);
  expect(bindings[2]).toEqual({ child: 2, parent: 2 });
  // Stdin/stdout ends held by the parent (write, read) plus the child's references: nothing else.
  expect(Array.from(record.held.keys())).toEqual([0, 1]);
  expect(fake.pipes.size).toBe(2);

  child.stdin.write("ping");
  expect(fake.childRead(record, 0)).toBe("ping");
  child.stdin.end();
  fake.childWrite(record, 1, "pong");
  fake.exit(record, 3);
  await pump();
  expect(await child.exited).toBe(3);
  expect(child.exitCode).toBe(3);
  expect(child.signalCode).toBeNull();
  expect(await child.stdout.text()).toBe("pong");
  expect(record.reaped).toBe(false); // the caller's job is not ours to reap
  expect(fake.pipes.size).toBe(0);
});

test("a selected signal death is a signal, an ordinary 143 is not", async () => {
  const fake = service();
  const { module, pump } = load(fake);
  const killed = module.spawn(["bun", "a"], { stdout: "pipe" });
  killed.kill("SIGTERM");
  await pump();
  expect(await killed.exited).toBe(143);
  expect(killed.signalCode).toBe("SIGTERM");
  expect(killed.exitCode).toBeNull();
  expect(killed.killed).toBe(true);

  const ordinary = module.spawn(["bun", "b"], { stdout: "pipe" });
  fake.exit(fake.children.get(ordinary.pid)!, 143);
  await pump();
  expect(await ordinary.exited).toBe(143);
  expect(ordinary.signalCode).toBeNull();
  expect(ordinary.exitCode).toBe(143);
});

test("ignored stdio has no stream: stdin reads EOF, output is drained and dropped", async () => {
  const fake = service();
  const { module, pump } = load(fake);
  const child = module.spawn(["bun", "x"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  const record = fake.children.get(child.pid)!;
  expect(child.stdin).toBeNull();
  expect(child.stdout).toBeNull();
  expect(child.stderr).toBeNull();
  expect(fake.childRead(record, 0)).toBeNull(); // no writer left: end of file
  fake.childWrite(record, 1, "dropped");
  fake.childWrite(record, 2, "dropped");
  fake.exit(record, 0);
  await pump();
  expect(await child.exited).toBe(0);
  expect(fake.pipes.size).toBe(0);
});

test("a failed spawn throws the errno and leaks no descriptors", () => {
  const fake = service({ failSpawn: ENOENT });
  const { module } = load(fake);
  expect(() => module.spawn(["nope"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" })).toThrow(/spawn nope ENOENT/);
  expect(fake.open()).toBe(0);
  expect(() => module.spawnSync(["nope"], {})).toThrow(/spawn nope ENOENT/);
  expect(fake.open()).toBe(0);
});

test("worker children get two bound control pipes announced through the environment", () => {
  const fake = service();
  const { module } = load(fake);
  const child = module.spawn(["bun", "w"], { stdout: "pipe", stderr: "pipe", env: { K: "v" }, _worker: { memoryLimitMb: 64 } });
  const request = fake.children.get(child.pid)!.request;
  const control = JSON.parse(request.env.BUNWASM_WORKER_CONTROL);
  const extra = request.fds.filter((binding: any) => binding.child > 2);
  expect(extra.map((binding: any) => binding.child)).toEqual([control.input, control.output]);
  expect(extra.every((binding: any) => binding.child === binding.parent)).toBe(true);
  expect(request.worker).toEqual({ memoryLimitMb: 64 });
  expect(request.env.K).toBe("v");
  // The parent keeps the other ends: it reads what the worker writes and writes what it reads.
  const { input, output } = child._workerChannel;
  expect(new Set([input, output, control.input, control.output]).size).toBe(4);
  expect(fake.native.procWrite(output, new TextEncoder().encode("hi"))).toBe(2);
  expect(fake.childRead(fake.children.get(child.pid)!, control.input)).toBe("hi");
  fake.childWrite(fake.children.get(child.pid)!, control.output, "ok");
  expect(new TextDecoder().decode(fake.native.procRead(input, 16) as Uint8Array)).toBe("ok");
});

test("the idle loop sleeps on exactly the descriptors and child the waiter watches", () => {
  const fake = service();
  const { module, waiters } = load(fake);
  const child = module.spawn(["bun", "s"], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
  const record = fake.children.get(child.pid)!;
  const kinds = () => decode(waiters[0].subscriptions());
  // stdout readable and the child exit; stdin has nothing queued to write.
  expect(kinds().map(([kind]) => kind)).toEqual([0, 2]);
  expect(kinds()[1][1]).toBe(child.pid);
  fake.childWrite(record, 1, "tail");
  fake.exit(record, 0);
  waiters[0].step();
  // Exited and reaped, but output is still being drained: only the pipe remains.
  expect(kinds().map(([kind]) => kind)).toEqual([0]);
  waiters[0].step();
  expect(kinds()).toEqual([]);
});

test("spawnSync collects output and classifies the exit", () => {
  const fake = service();
  const { module } = load(fake);
  const original = fake.native.procPoll;
  fake.native.procPoll = (subscriptions: Uint8Array) => {
    original(subscriptions);
    // The child runs while the parent sleeps: it answers on stdout, then exits 7.
    const record = Array.from(fake.children.values())[0];
    if (record && !record.status) { fake.childWrite(record, 1, "out"); fake.childWrite(record, 2, "err"); fake.exit(record, 7); }
    return new Uint8Array(0);
  };
  const result = module.spawnSync(["bun", "sync"], { stdin: new Uint8Array([1, 2, 3]) });
  expect(result.exitCode).toBe(7);
  expect(result.signalCode).toBeNull();
  expect(result.success).toBe(false);
  expect(result.stdout.toString()).toBe("out");
  expect(result.stderr.toString()).toBe("err");
  expect(fake.calls).not.toContain("reap");
  expect(fake.pipes.size).toBe(0);
});

test("spawnSync timeout kills with the requested signal and reports it", () => {
  const fake = service();
  const { module } = load(fake);
  const result = module.spawnSync(["bun", "slow"], { timeout: 1, killSignal: "SIGKILL" });
  expect(result.exitedDueToTimeout).toBe(true);
  expect(result.signalCode).toBe("SIGKILL");
  expect(result.exitCode).toBeNull();
  expect(result.success).toBe(false);
  expect(fake.pipes.size).toBe(0);
});

test("children join the caller's job and the guest never reaps or kills that job", async () => {
  const fake = service();
  const { module, pump } = load(fake);
  const child = module.spawn(["bun", "j"], { stdout: "pipe" });
  const record = fake.children.get(child.pid)!;
  expect(record.request.job).toBe(3);
  fake.exit(record, 0);
  await pump();
  expect(await child.exited).toBe(0);
  const sync = module.spawnSync(["bun", "k"], { timeout: 1, killSignal: "SIGKILL" });
  expect(sync.signalCode).toBe("SIGKILL");
  expect(fake.calls).not.toContain("reap");
});

test("a detached child starts a new job that the guest owns and reaps", async () => {
  const fake = service();
  const { module, pump } = load(fake);
  const child = module.spawn(["bun", "d"], { stdout: "pipe", detached: true });
  const record = fake.children.get(child.pid)!;
  expect(record.request.job).toBe(0);
  fake.exit(record, 0);
  await pump();
  expect(await child.exited).toBe(0);
  expect(record.reaped).toBe(true);
});

test("a caller whose job cannot be named fails the spawn instead of starting a new job", () => {
  const fake = service();
  fake.native.ownJob = -71;
  const { module } = load(fake);
  expect(() => module.spawn(["bun", "j"], { stdout: "pipe", stdin: "pipe" })).toThrow(/spawn bun ESRCH/);
  expect(fake.calls).not.toContain("spawn");
  expect(fake.open()).toBe(0);
  expect(() => module.spawnSync(["bun", "j"], {})).toThrow(/spawn bun ESRCH/);
  expect(fake.children.size).toBe(0);
  // Detaching does not need the caller's job.
  const detached = module.spawn(["bun", "j"], { stdout: "pipe", detached: true });
  expect(fake.children.get(detached.pid)!.request.job).toBe(0);
});

for (const executable of ["node", "/usr/bin/node", "fixture.wasm", "/tools/custom"]) test(`the executable ${executable} follows PATH only when it has no slash`, () => {
  const fake = service();
  const { module } = load(fake);
  module.spawn([executable, "argument"]);
  const request = Array.from(fake.children.values())[0]!.request;
  expect(request.executable).toBe(executable.includes("/") ? executable : `/bin/${executable}`);
  expect(request.argv).toEqual([executable, "argument"]);
});

for (const ownCode of [23, 143]) test(`a handled TERM keeps the guest's own exit code ${ownCode}`, async () => {
  const fake = service();
  const { module, pump } = load(fake);
  // A handled signal is delivered but selects no outcome; the guest then exits on its own.
  fake.native.procKill = () => 0;
  const child = module.spawn(["bun", "handler"], { stdout: "pipe" });
  child.kill("SIGTERM");
  fake.exit(fake.children.get(child.pid)!, ownCode);
  await pump();
  expect(await child.exited).toBe(ownCode);
  expect(child.exitCode).toBe(ownCode);
  expect(child.signalCode).toBeNull();
  expect(child.killed).toBe(true);
});

test("Bun child.kill accepts all standard Linux signal names and aliases", async () => {
  const namedSignals: Record<string, number> = {
    SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGILL: 4, SIGTRAP: 5, SIGABRT: 6, SIGIOT: 6,
    SIGBUS: 7, SIGFPE: 8, SIGKILL: 9, SIGUSR1: 10, SIGSEGV: 11, SIGUSR2: 12,
    SIGPIPE: 13, SIGALRM: 14, SIGTERM: 15, SIGSTKFLT: 16, SIGCHLD: 17, SIGCONT: 18,
    SIGSTOP: 19, SIGTSTP: 20, SIGTTIN: 21, SIGTTOU: 22, SIGURG: 23, SIGXCPU: 24,
    SIGXFSZ: 25, SIGVTALRM: 26, SIGPROF: 27, SIGWINCH: 28, SIGIO: 29, SIGPOLL: 29,
    SIGPWR: 30, SIGSYS: 31,
  };
  for (const [name, number] of Object.entries(namedSignals)) for (const spelling of [name, name.toLowerCase()]) {
    const fake = service();
    const { module, pump } = load(fake);
    const child = module.spawn(["bun", "named-signal"], { stdout: "pipe" });
    child.kill(spelling);
    // The service fixture accepts requests here; host disposition/unsupported-stop policy is separate.
    expect(fake.calls.filter((call) => call.startsWith("kill:"))).toEqual([`kill:${number}`]);
    await pump();
    expect(await child.exited).toBe(128 + number);
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBe(name === "SIGIOT" ? "SIGABRT" : name === "SIGPOLL" ? "SIGIO" : name);
    expect(fake.open()).toBe(0);
  }
});

for (const timeout of [0, 1]) {
  test(`spawnSync returns before detached descendants finish (timeout ${timeout})`, async () => {
    let now = 0;
    const fake = service({
      now: () => now++,
      onSpawn(record) {
        record.liveDescendants = 1; // An independently redirected grandchild still belongs to the job.
        if (!timeout) fake.exit(record, 0);
      },
      onPoll(turn) {
        // Only the timeout path needs a child-exit poll; JOB_EMPTY must never block this call.
        expect(timeout).toBe(1);
        expect(turn).toBe(1);
      },
    });
    const { module, waiters, pump } = load(fake);
    const result = module.spawnSync(["bun", "detached-leader"], {
      detached: true, stdio: ["inherit", "inherit", "inherit"], timeout, killSignal: "SIGKILL",
    });
    expect(result.error).toBeUndefined();
    expect(result.exitCode).toBe(timeout ? null : 0);
    expect(result.signalCode).toBe(timeout ? "SIGKILL" : null);
    expect(result.exitedDueToTimeout).toBe(Boolean(timeout));
    const record = fake.children.get(result.pid)!;
    expect(record.reaped).toBe(false);
    expect(waiters).toHaveLength(1);
    expect(waiters[0].ref).toBe(false);
    expect(decode(waiters[0].subscriptions())).toEqual([[4, record.job]]);
    expect(fake.calls.filter((call) => call.startsWith("killJob:"))).toEqual([]);
    record.liveDescendants = 0;
    await pump();
    expect(record.reaped).toBe(true);
    expect(waiters).toHaveLength(0);
    expect(fake.open()).toBe(0);
  });
}

test("async detached completion hands surviving descendants to an unref'd reaper", async () => {
  const fake = service();
  const { module, waiters, pump, pumpTurn } = load(fake);
  const child = module.spawn(["bun", "detached-leader"], { detached: true, stdout: "pipe" });
  const record = fake.children.get(child.pid)!;
  record.liveDescendants = 1;
  fake.exit(record, 0);
  pumpTurn();
  expect(await child.exited).toBe(0);
  expect(waiters).toHaveLength(1);
  expect(waiters[0].ref).toBe(false);
  expect(decode(waiters[0].subscriptions())).toEqual([[4, record.job]]);
  expect(record.reaped).toBe(false);
  expect(fake.open()).toBe(0);
  expect(fake.calls.filter((call) => call.startsWith("kill"))).toEqual([]);
  record.liveDescendants = 0;
  await pump();
  expect(record.reaped).toBe(true);
  expect(waiters).toHaveLength(0);
});

test("queued stdin EPIPE drops input without abandoning the still-running child", async () => {
  const fake = service();
  const { module, pump, pumpTurn, waiters } = load(fake);
  const child = module.spawn(["bun", "closes-stdin"], { stdin: "pipe", stdout: "pipe" });
  const record = fake.children.get(child.pid)!;
  const write = fake.native.procWrite;
  fake.native.procWrite = () => EAGAIN;
  child.stdin.write("queued input");
  fake.childClose(record, 0);
  fake.native.procWrite = write;
  pumpTurn();
  expect(record.status).toBeNull();
  expect(child.stdin.closed).toBe(true);
  expect(waiters).toHaveLength(1);
  expect(fake.calls.filter((call) => call.startsWith("kill"))).toEqual([]);
  fake.childWrite(record, 1, "still running");
  fake.exit(record, 23);
  await pump();
  expect(await child.exited).toBe(23);
  expect(child.exitCode).toBe(23);
  expect(await child.stdout.text()).toBe("still running");
  expect(fake.open()).toBe(0);
  expect(waiters).toHaveLength(0);
});

for (const detached of [false, true]) for (const failure of ["read", "write"]) {
  test(`async ${failure} failure terminates and observes the child (detached ${detached})`, async () => {
    const fake = service();
    const timers = new Map<unknown, () => void>();
    const { module, pump, pumpTurn, waiters } = load(fake, { timers: {
      setTimeout(callback) { const handle = {}; timers.set(handle, callback); return handle; },
      clearTimeout(handle) { timers.delete(handle); },
      setImmediate,
    } });
    const controller = new AbortController();
    const removedListeners: string[] = [];
    const removeListener = controller.signal.removeEventListener.bind(controller.signal);
    controller.signal.removeEventListener = (type, listener, options) => {
      removedListeners.push(type);
      removeListener(type, listener, options);
    };
    let onExit = 0;
    const child = module.spawn(["bun", "io-failure"], {
      detached, stdin: "pipe", stdout: "pipe", timeout: 10, signal: controller.signal,
      onExit() { onExit++; },
    });
    expect(timers.size).toBe(1);
    const record = fake.children.get(child.pid)!;
    // Hold the selected death until explicitly published, just as teardown can on real hosts.
    const kill = detached ? fake.native.procKillJob : fake.native.procKill;
    const request = (id: number, signal: number) => {
      fake.select(record, [1, signal]);
      return kill(id, signal);
    };
    if (detached) fake.native.procKillJob = request;
    else fake.native.procKill = request;
    if (failure === "write") {
      fake.native.procWrite = () => EAGAIN;
      child.stdin.write("queued input");
      fake.native.procWrite = () => -29;
    } else fake.native.procRead = () => -29;
    // Attach handlers without entering Bun's pending-promise matcher before the manual pump.
    const rejected = child.exited.catch((error: unknown) => error);
    const outputError = child.stdout.getReader().read().catch((error: unknown) => error);
    pumpTurn();
    expect(await rejected).toMatchObject({ code: "EIO", syscall: failure });
    expect(await outputError).toMatchObject({ code: "EIO" });
    expect(timers.size).toBe(0);
    expect(removedListeners).toEqual(["abort"]);
    controller.abort();
    expect(onExit).toBe(0);
    expect(record.selected).toEqual([1, 9]);
    expect(record.status).toBeNull();
    expect(fake.calls.filter((call) => call.startsWith("kill"))).toEqual([detached ? "killJob:9" : "kill:9"]);
    expect(fake.open()).toBe(0);
    expect(waiters).toHaveLength(1);
    expect(waiters[0].ref).toBe(false);
    expect(decode(waiters[0].subscriptions())).toEqual([[2, child.pid]]);
    fake.publish(record);
    await pump();
    expect(onExit).toBe(0); // Cleanup must not report a second, successful public completion.
    expect(record.reaped).toBe(detached);
    expect(waiters).toHaveLength(0);
    expect(fake.open()).toBe(0);
  });
}

for (const ownCode of [23, 137, 143]) for (const acceptance of [0, -71]) {
  test(`a late SIGKILL returning ${acceptance} preserves ordinary exit ${ownCode}`, async () => {
    const fake = service();
    const { module, pump, waiters } = load(fake);
    const kill = fake.native.procKill;
    fake.native.procKill = (pid: number, signal: number) => {
      // The guest selects and publishes its own exit between the alive check and kill.
      fake.exit(fake.children.get(pid)!, ownCode);
      kill(pid, signal);
      return acceptance;
    };
    const child = module.spawn(["bun", "late-kill"], { stdout: "pipe" });
    expect(() => child.kill("SIGKILL")).not.toThrow();
    await pump();
    expect(await child.exited).toBe(ownCode);
    expect(child.exitCode).toBe(ownCode);
    expect(child.signalCode).toBeNull();
    expect(child.killed).toBe(acceptance === 0);
    expect(fake.calls.filter((call) => call.startsWith("kill:"))).toEqual(["kill:9"]);
    expect(waiters).toHaveLength(0);
    expect(fake.open()).toBe(0);
  });
}

test("spawnSync timeout SIGKILL losing to ordinary exit 143 does not relabel it", () => {
  let now = 0;
  const fake = service({ now: () => now++ });
  const { module } = load(fake);
  const kill = fake.native.procKill;
  fake.native.procKill = (pid: number, signal: number) => {
    fake.exit(fake.children.get(pid)!, 143);
    kill(pid, signal);
    return -71; // runtime_proc ESRCH, not a legacy child-slot errno
  };
  const result = module.spawnSync(["bun", "late-timeout"], { timeout: 1, killSignal: "SIGKILL" });
  expect(result.error).toBeUndefined();
  expect(result.exitedDueToTimeout).toBe(true);
  expect(result.exitCode).toBe(143);
  expect(result.signalCode).toBeNull();
  expect(result.success).toBe(false);
  expect(fake.calls.filter((call) => call.startsWith("kill:"))).toEqual(["kill:9"]);
  expect(fake.open()).toBe(0);
});

test("async SIGKILL cannot overwrite ordinary exit 143 while publication is delayed", async () => {
  const fake = service({ onSpawn(record) { fake.select(record, [0, 143]); } });
  const { module, pump, waiters } = load(fake);
  const exits: unknown[][] = [];
  const child = module.spawn(["bun", "delayed-exit"], {
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
    onExit(_child: unknown, exitCode: number | null, signalCode: string | null, error: unknown) {
      exits.push([exitCode, signalCode, error]);
    },
  });
  const record = fake.children.get(child.pid)!;
  let resolved = false;
  child.exited.then(() => { resolved = true; });
  child.kill("SIGKILL");
  for (let turn = 0; turn < 3; turn++) waiters[0].step();
  await Promise.resolve();
  expect(record.selected).toEqual([0, 143]);
  expect(record.status).toBeNull();
  expect(child.exitCode).toBeNull();
  expect(child.signalCode).toBeNull();
  expect(resolved).toBe(false);
  expect(exits).toEqual([]);
  expect(fake.open()).toBe(3); // Teardown is not complete: every parent pipe is still open.
  expect(decode(waiters[0].subscriptions())).toContainEqual([2, child.pid]);
  expect(fake.calls.filter((call) => call.startsWith("kill:"))).toEqual(["kill:9"]);

  fake.publish(record);
  await pump();
  expect(await child.exited).toBe(143);
  expect(child.exitCode).toBe(143);
  expect(child.signalCode).toBeNull();
  expect(exits).toEqual([[143, null, null]]);
  expect(waiters).toHaveLength(0);
  expect(fake.open()).toBe(0);
});

test("spawnSync timeout requests one SIGKILL while ordinary exit 143 awaits publication", () => {
  let now = 0;
  let polls = 0;
  const fake = service({
    now: () => now++,
    onSpawn(record) { fake.select(record, [0, 143]); },
    onPoll(turn) {
      polls = turn;
      expect(turn).toBeLessThanOrEqual(5);
      const record = Array.from(fake.children.values())[0]!;
      expect(record.status).toBeNull();
      expect(record.selected).toEqual([0, 143]);
      expect(fake.open()).toBe(1);
      expect(fake.calls.filter((call) => call.startsWith("kill:"))).toEqual(["kill:9"]);
      if (turn === 5) fake.publish(record);
    },
  });
  const { module } = load(fake);
  const result = module.spawnSync(["bun", "delayed-timeout"], {
    stdio: ["inherit", "pipe", "inherit"], timeout: 1, killSignal: "SIGKILL",
  });
  expect(polls).toBe(5);
  expect(result.error).toBeUndefined();
  expect(result.exitedDueToTimeout).toBe(true);
  expect(result.exitCode).toBe(143);
  expect(result.signalCode).toBeNull();
  expect(result.success).toBe(false);
  expect(fake.calls.filter((call) => call.startsWith("kill:"))).toEqual(["kill:9"]);
  expect(fake.open()).toBe(0);
});

const maxBufferOutcomes: { outcome: ProcessExit; exitCode: number | null; signalCode: string | null }[] = [
  { outcome: [1, 9], exitCode: null, signalCode: "SIGKILL" },
  { outcome: [0, 137], exitCode: 137, signalCode: null },
  { outcome: [0, 143], exitCode: 143, signalCode: null },
  { outcome: [0, 23], exitCode: 23, signalCode: null },
  { outcome: [0, 0], exitCode: 0, signalCode: null },
];
for (const { outcome, exitCode, signalCode } of maxBufferOutcomes) {
  test(`spawnSync maxBuffer waits for delayed ${signalCode ?? `ordinary exit ${exitCode}`} before closing output`, () => {
    let polls = 0;
    let stdoutFd = -1;
    const closes: number[] = [];
    const fake = service({
      onSpawn(record) {
        // Output can precede teardown and publication, whichever outcome won selection.
        fake.childWrite(record, 1, "xx");
        fake.select(record, outcome);
        stdoutFd = Array.from(fake.pipes).find(([, entry]) => !entry.write)![0];
      },
      onPoll(turn) {
        polls = turn;
        expect(turn).toBeLessThanOrEqual(3);
        const record = Array.from(fake.children.values())[0]!;
        expect(record.status).toBeNull();
        expect(record.selected).toEqual(outcome);
        expect(fake.open()).toBe(1);
        expect(closes).toEqual([]);
        expect(fake.calls.filter((call) => call.startsWith("kill:"))).toEqual(["kill:9"]);
        // The failed read stays subscribed, along with the unpublished child outcome.
        expect(decode(waitSubscriptions)).toContainEqual([0, stdoutFd]);
        expect(decode(waitSubscriptions)).toContainEqual([2, record.pid]);
        if (turn === 3) fake.publish(record);
      },
    });
    let waitSubscriptions = new Uint8Array(0);
    const poll = fake.native.procPoll;
    fake.native.procPoll = (subscriptions: Uint8Array) => {
      waitSubscriptions = subscriptions;
      return poll(subscriptions);
    };
    const close = fake.native.procClose;
    fake.native.procClose = (fd: number) => {
      if (fd === stdoutFd) {
        expect(polls).toBe(3);
        expect(Array.from(fake.children.values())[0]!.status).toEqual(outcome);
        closes.push(fd);
      }
      return close(fd);
    };
    const { module } = load(fake);
    const result = module.spawnSync(["bun", "overflow"], {
      stdio: ["inherit", "pipe", "inherit"], maxBuffer: 1,
    });
    expect(result.error.code).toBe("ENOBUFS");
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(exitCode);
    expect(result.signalCode).toBe(signalCode);
    expect(polls).toBe(3);
    expect(closes).toEqual([stdoutFd]);
    expect(fake.calls.filter((call) => call.startsWith("kill:"))).toEqual(["kill:9"]);
    expect(fake.open()).toBe(0);
  });
}

test("a missing or non-directory cwd is the spawn error and starts nothing", async () => {
  const fake = service();
  const { module } = load(fake);
  for (const [cwd, code, errno] of [["/does-not-exist", "ENOENT", -2], ["/work/file.txt", "ENOTDIR", -20]] as const) {
    const node = module.nodeChildProcess();
    const child = node.spawn("bun", ["x"], { cwd, stdio: "pipe" });
    const emitted: any = await new Promise((resolve) => child.once("error", resolve));
    expect(emitted).toMatchObject({ code, errno, syscall: "spawn bun", path: "bun", message: `spawn bun ${code}` });
    expect(() => module.spawn(["bun", "x"], { cwd })).toThrow(`spawn bun ${code}`);
    expect(() => module.spawnSync(["bun", "x"], { cwd, stdin: new Uint8Array(1) })).toThrow(`spawn bun ${code}`);
    const sync = node.spawnSync("bun", ["x"], { cwd });
    expect(sync.error).toMatchObject({ code, syscall: "spawnSync bun" });
    expect(sync.status).toBeNull();
  }
  // Nothing was spawned, no job was looked up and no descriptor was created or leaked.
  expect(fake.calls).not.toContain("spawn");
  expect(fake.children.size).toBe(0);
  expect(fake.open()).toBe(0);
  // A relative cwd resolves against the guest cwd before the check.
  expect(module.spawn(["bun", "x"], { cwd: "../tmp", stdout: "pipe" }).pid).toBeGreaterThan(0);
});

test("a supported signal name the process service rejects as unsupported is an ENOTSUP kill error", () => {
  const fake = service();
  const { module } = load(fake);
  const child = module.spawn(["bun", "stop"], { stdout: "pipe" });
  fake.native.procKill = () => -58;
  try { child.kill("SIGSTOP"); throw new Error("kill should fail"); } catch (error: any) {
    expect(error).toMatchObject({ code: "ENOTSUP", errno: -95, syscall: "kill", message: "kill ENOTSUP" });
  }
  expect(child.killed).toBe(false);
});

for (const selected of [[0, 23], [0, 143], [1, 9]] as const) {
  test(`spawnSync TERM timeout retains actual outcome ${selected[0]}:${selected[1]}`, () => {
    let now = 0;
    let requested = false;
    const fake = service({ now: () => now++, onPoll() {
      if (!requested) return;
      const child = Array.from(fake.children.values())[0]!;
      fake.select(child, selected[0] === 0 ? [0, selected[1]] : [1, selected[1]]);
      fake.publish(child);
    } });
    fake.native.procKill = (_pid: number, signal: number) => {
      fake.calls.push(`kill:${signal}`);
      expect(signal).toBe(15);
      requested = true;
      return 0; // TERM handler is queued; its later result is not necessarily signal death.
    };
    const { module } = load(fake);
    const result = module.spawnSync(["bun", "term-handler"], { timeout: 1, killSignal: "SIGTERM" });
    expect(result.exitedDueToTimeout).toBe(true);
    expect(result.exitCode).toBe(selected[0] === 0 ? selected[1] : null);
    expect(result.signalCode).toBe(selected[0] === 1 ? "SIGKILL" : null);
    expect(fake.calls.filter(call => call.startsWith("kill:"))).toEqual(["kill:15"]);
    expect(fake.open()).toBe(0);
  });
}

for (const sync of [false, true]) for (const input of [
  { _bytes() { throw new Error("invalid stdin bytes"); } },
  { get getReader() { throw new Error("invalid stdin reader"); } },
]) test(`stdin conversion fails before launch (sync ${sync}, ${"_bytes" in input ? "bytes" : "reader"})`, () => {
  const fake = service();
  const { module, waiters } = load(fake);
  expect(() => (sync ? module.spawnSync : module.spawn)(["bun", "input"], { stdin: input })).toThrow(/invalid stdin/);
  expect(fake.calls).not.toContain("spawn");
  expect(fake.children.size).toBe(0);
  expect(fake.open()).toBe(0);
  expect(waiters).toHaveLength(0);
});

test("synchronous streaming stdin is rejected before launch", () => {
  const fake = service();
  const { module, waiters } = load(fake);
  expect(() => module.spawnSync(["bun", "input"], { stdin: new ReadableStream() })).toThrow(/Synchronous streaming stdin/);
  expect(fake.children.size).toBe(0);
  expect(fake.open()).toBe(0);
  expect(waiters).toHaveLength(0);
});

for (const queued of [false, true]) test(`spawnSync drops ${queued ? "queued" : "initial"} stdin EPIPE and preserves output and exit`, () => {
  const fake = service({ onSpawn(child) { if (!queued) fake.childClose(child, 0); } });
  const { module } = load(fake);
  const write = fake.native.procWrite;
  let polls = 0;
  fake.native.procWrite = (fd: number, bytes: Uint8Array) => queued && !polls ? EAGAIN : write(fd, bytes);
  fake.native.procPoll = () => {
    const child = Array.from(fake.children.values())[0];
    if (++polls === 1) {
      if (queued) fake.childClose(child, 0);
      fake.childWrite(child, 1, "still running");
      fake.childWrite(child, 2, "diagnostic");
    } else fake.exit(child, 23);
    return new Uint8Array(0);
  };
  const result = module.spawnSync(["bun", "closes-stdin"], { stdin: "input", detached: true });
  expect(result.error).toBeUndefined();
  expect(result.exitCode).toBe(23);
  expect(result.signalCode).toBeNull();
  expect(result.stdout.toString()).toBe("still running");
  expect(result.stderr.toString()).toBe("diagnostic");
  expect(fake.calls.filter(call => call.startsWith("kill"))).toEqual([]);
  expect(fake.calls).toContain("reap");
  expect(fake.open()).toBe(0);
});

test("Node stdin destroy closes its runtime_proc writer and delivers EOF", async () => {
  const fake = service();
  const { module, pump } = load(fake);
  const node = module.nodeChildProcess();
  const child = node.spawn("bun", ["wait-for-eof"]);
  const record = fake.children.get(child.pid)!;
  expect(fake.childRead(record, 0)).toBe("");
  child.stdin.destroy();
  expect(fake.childRead(record, 0)).toBeNull();
  fake.exit(record, 0);
  await pump();
  expect(fake.open()).toBe(0);
  expect(fake.calls.filter(call => call.startsWith("kill"))).toEqual([]);
});

for (const outcome of [[0, 0], [2, 44]] as const) {
  test(`Node kill(0) observes startup before consuming completion ${outcome[0]}`, async () => {
    const fake = service({ deferStart: true });
    const { module, pump } = load(fake);
    const child = module.nodeChildProcess().spawn("bun", ["-e", "0"], { stdio: "pipe" });
    const events: string[] = [];
    child.on("spawn", () => events.push("spawn"));
    child.on("error", () => events.push("error"));
    child.on("exit", () => events.push("exit"));
    const record = fake.children.get(child.pid)!;
    record.started = outcome[0] === 0;
    fake.select(record, outcome);
    fake.publish(record);
    child.kill(0);
    expect(events).toEqual([]);
    child.on("spawn", () => events.push("late-spawn"));
    await pump();
    expect(events).toEqual(outcome[0] === 0 ? ["spawn", "late-spawn", "exit"] : ["error"]);
    expect(fake.pipes.size).toBe(0);
  });
}
