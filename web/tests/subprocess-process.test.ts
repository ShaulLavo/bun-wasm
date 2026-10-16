import { expect, test } from "bun:test";
import { SubprocessHost, childTransport, type ChildTransport } from "../src/subprocess.ts";

function fixture() {
  const launched: ChildTransport[] = [];
  const events: string[] = [];
  const host = new SubprocessHost({
    output() {},
    launch(_meta, transport) {
      launched.push(transport);
      return { revoke() { events.push("revoke"); }, terminate() { events.push("terminate"); } };
    },
  });
  return { host, launched, events };
}

const command = (executable = "fixture") => JSON.stringify({ argv: [executable, "argument"], executable });

test("first spawn reserves an arbitrary executable without waiting for activation", () => {
  const { host, launched } = fixture();
  try {
    const pid = host.spawn(command("/tools/fixture.wasm"));
    expect(pid).toBeGreaterThan(1);
    expect(launched[0]?.pid).toBe(pid);
    expect(launched[0]?.parentPid).toBe(1);
    expect(host.wait(pid)).toBe(-2);
  } finally { host.dispose(); }
});

test("nested stubs share globally unique process ids and never reuse signal buffers", () => {
  const { host, launched } = fixture();
  const first = host.spawn(command());
  const parent = launched[0]!;
  let nestedTransport: ChildTransport | undefined;
  const nested = new SubprocessHost({
    budget: parent.budget, slot: parent.slot, token: parent.token,
    identity: parent.identity, pid: parent.pid, jobId: parent.jobId,
    output() {}, launch(_meta, transport) { nestedTransport = transport; return { terminate() {} }; },
  });
  try {
    const descendant = nested.spawn(command());
    expect(descendant).not.toBe(first);
    expect(nestedTransport?.parentPid).toBe(first);
    expect(nestedTransport?.jobId).toBe(parent.jobId);
    host.kill(first, 9);
    const replacement = host.spawn(command());
    expect(replacement).not.toBe(first);
    expect(launched[1]?.interrupt).not.toBe(parent.interrupt);
    expect(launched[1]?.requestedSignal).not.toBe(parent.requestedSignal);
  } finally { nested.dispose(); host.dispose(); }
});

test("SIGKILL revokes before termination and wins over a late success", () => {
  const { host, launched, events } = fixture();
  try {
    const pid = host.spawn(command());
    expect(host.kill(pid, 9)).toBe(0);
    expect(events.slice(0, 2)).toEqual(["revoke", "terminate"]);
    expect(Atomics.load(new Int32Array(launched[0]!.interrupt), 0)).toBe(9);
    childTransport(launched[0]!).finish(0);
    expect(host.wait(pid)).toBe(137);
  } finally { host.dispose(); }
});

test("catchable signals notify the guest without destroying descriptors or overriding its exit", () => {
  const { host, launched, events } = fixture();
  try {
    const pid = host.spawn(command());
    expect(host.kill(pid, 15)).toBe(0);
    expect(events).toEqual([]);
    expect(host.wait(pid)).toBe(-2);
    expect(Atomics.exchange(new Int32Array(launched[0]!.interrupt), 0, 0)).toBe(15);
    childTransport(launched[0]!).finish(23);
    expect(host.wait(pid)).toBe(23);
  } finally { host.dispose(); }
});

test("invalid executable metadata is rejected before launch", () => {
  const { host, launched } = fixture();
  try {
    for (const executable of ["", "bad\0path", 4, null]) expect(host.spawn(JSON.stringify({ executable, argv: ["fixture"] }))).toBe(-1);
    expect(launched).toHaveLength(0);
  } finally { host.dispose(); }
});

test("SIGKILL closes transport endpoints before physical termination", () => {
  let writesAtTerminate: number[] | undefined;
  const host = new SubprocessHost({ output() {}, launch(_meta, transport) {
    return { terminate() {
      const child = childTransport(transport);
      writesAtTerminate = [child.stdin.write(new Uint8Array([1])), child.stdout.write(new Uint8Array([1]))];
    } };
  } });
  try {
    const pid = host.spawn(command());
    host.kill(pid, 9);
    expect(writesAtTerminate).toEqual([-1, -1]);
  } finally { host.dispose(); }
});

test("new job ids are separate from inherited job identity and survive parent detach", () => {
  const { host, launched, events } = fixture();
  try {
    const first = host.spawn(JSON.stringify({ argv: ["fixture"], job: -1 }));
    const second = host.spawn(JSON.stringify({ argv: ["fixture"], job: 0 }));
    expect(launched[0]?.jobId).toBeGreaterThan(1);
    expect(launched[1]?.jobId).not.toBe(launched[0]?.jobId);
    expect(first).not.toBe(second);
    host.detach();
    expect(events).toEqual([]);
    expect(host.wait(first)).toBe(-2);
    expect(host.wait(second)).toBe(-2);
  } finally { host.dispose(); }
});

test("a previously recorded SIGKILL cannot be replaced by a catchable signal", () => {
  const { host, launched } = fixture();
  try {
    const pid = host.spawn(command());
    Atomics.store(new Int32Array(launched[0]!.requestedSignal), 0, 9);
    host.kill(pid, 15);
    expect(Atomics.load(new Int32Array(launched[0]!.requestedSignal), 0)).toBe(9);
    expect(host.wait(pid)).toBe(137);
  } finally { host.dispose(); }
});
