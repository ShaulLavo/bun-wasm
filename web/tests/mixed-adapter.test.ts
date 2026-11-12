import { expect, test } from "bun:test";
import type { NotificationWaitSet } from "waffle/browser/notification-wait";
import { ProcessError } from "waffle/proc";
import { requestSignal, signalPending } from "waffle/proc/signals";
import { createRing } from "waffle/browser/net/ring";
import { NetHost } from "../src/net/host";
import { processFixture } from "./fixtures/mixed-process";

function adapter(shared = false) {
  const process = processFixture(shared);
  const host = new NetHost(createRing(), () => {});
  const coverage: unknown[] = [];
  let active = () => {};
  const set: NotificationWaitSet = {
    covered: true, disposed: false,
    sample: () => ({ sequence: 0, filesystem: 0, network: 0, process: 0 }),
    wait: () => "closed", dispose() {},
    setProcessSubscriptions(subs) { coverage.push(subs); },
  };
  host.attach(process.memory);
  host.attachProcessWait(process.abi, set, () => active());
  return { ...process, host, set, coverage, slots: host.slots(), active(check: () => void) { active = check; },
    dispose() { host.runtime.dispose(); process.dispose(); } };
}

test("process spans and kinds are checked before network readiness; coverage restores after errors", () => {
  const f = adapter();
  try {
    f.host.runtime.listen("localhost", 0);
    expect(f.slots.poll_io!(65535, 1, 0, 128)).toBe(-21);
    expect(f.slots.poll_io!(64, 1, 0, 65535)).toBe(-21);
    expect(f.slots.poll_io!(64, -1, 0, 128)).toBe(-28);
    expect(f.slots.poll_io!(64, 1, NaN, 128)).toBe(-28);
    f.subscription(64, 99);
    expect(f.slots.poll_io!(64, 1, 0, 128)).toBe(-28);
    f.subscription(64, 0, 999);
    expect(f.slots.poll_io!(64, 1, 0, 128)).toBe(-8);
    expect(f.coverage).toEqual([[], [], [], [], [], []]);
  } finally { f.dispose(); }
});

for (const shared of [false, true]) {
  test(`nonzero input offset, multiple subscriptions and memory growth (shared=${shared})`, () => {
    const f = adapter(shared);
    try {
      f.memory.grow(1);
      f.subscription(65544);
      f.subscription(65560, 1, f.writeFd);
      f.writer.tryWrite([new Uint8Array([81])]);
      expect(f.slots.poll_io!(65544, 2, 0, 65600)).toBe(1);
      expect(new DataView(f.memory.buffer).getBigUint64(65600, true)).toBe(91n);
      const byte = new Uint8Array(1);
      expect(f.reader.tryRead([byte])).toBe(1);
      expect(byte[0]).toBe(81);
      expect(f.slots.poll_io!(65544, 1, 0, 65600)).toBe(0);
      expect(f.slots.poll_io!(65560, 1, 0, 65600)).toBe(1);
      expect(f.slots.poll!(0)).toBe(0);
      expect(f.coverage.at(-1)).toEqual([]);
    } finally { f.dispose(); }
  });
}

test("registration, scan and fatal cancellation failures restore idle coverage", () => {
  const f = adapter();
  try {
    f.subscription();
    const original = f.set.setProcessSubscriptions;
    f.set.setProcessSubscriptions = subs => { if (subs.length) throw new ProcessError(8, "registration"); original(subs); };
    expect(f.slots.poll_io!(64, 1, 0, 128)).toBe(-8);
    expect(f.coverage.at(-1)).toEqual([]);
    f.set.setProcessSubscriptions = original;
    f.active(() => { throw new Error("fatal"); });
    expect(() => f.slots.poll_io!(64, 1, 10, 128)).toThrow("fatal");
    expect(f.coverage.at(-1)).toEqual([]);
    f.active(() => {});
    f.set.wait = () => { throw new Error("wait failure"); };
    expect(() => f.slots.poll_io!(64, 1, 10, 128)).toThrow("wait failure");
    expect(f.coverage.at(-1)).toEqual([]);
  } finally { f.dispose(); }
});

test("pipe hangup is non-consuming and network news is never fabricated or consumed twice", () => {
  const f = adapter();
  try {
    f.subscription();
    f.writer.close();
    const listener = f.host.runtime.listen("localhost", 0);
    expect(f.slots.poll_io!(64, 1, 0, 128)).toBe(1);
    expect(f.slots.poll!(0)).toBe(0);
    expect(f.host.runtime.accept(listener)).toBe(-2);
    expect(f.reader.tryRead([new Uint8Array(1)])).toBe(0);
    expect(new DataView(f.memory.buffer).getUint32(140, true)).toBe(1);
  } finally { f.dispose(); }
});

test("handled signals stay queued and memory views refresh after process validation grows memory", () => {
  const f = adapter(true);
  try {
    f.subscription();
    const poll = f.abi.imports.poll!;
    let calls = 0;
    f.abi.imports.poll = (...args) => { const result = poll(...args); if (++calls === 1) f.memory.grow(1); return result; };
    f.writer.tryWrite([new Uint8Array([81])]);
    expect(f.slots.poll_io!(64, 1, 0, 128)).toBe(1);
    expect(f.memory.buffer.byteLength).toBe(131072);
    f.abi.imports.signal!(10, 2);
    requestSignal(f.signals, 10);
    expect(f.slots.poll_io!(64, 1, 0, 128)).toBe(0);
    expect(signalPending(f.signals)).toBe(true);
    expect(f.abi.imports.signal!(0, 0)).toBe(10);
    expect(f.reader.tryRead([new Uint8Array(1)])).toBe(1);
  } finally { f.dispose(); }
});
