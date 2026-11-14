import { expect, test } from "bun:test";
import { openExit, NativeExitError, type ExitSyscalls } from "./safari-exit-syscalls";
import { ExitOwner } from "./safari-exit-observer";
import { fakeNative } from "./safari-exit-fixture";

function syscalls() {
  const order: string[] = [];
  let failure = 77;
  let registration = true;
  const result = { create: 10, register: 1, poll: 0, close: 0, eventData: 5888n, eventFlags: 0x86000000, receiptData: 0n };
  const system: ExitSyscalls = {
    kqueue() { order.push("kqueue"); failure = 24; return result.create; },
    kevent64(fd, change, event) {
      registration = change !== null;
      order.push(registration ? "register" : "poll");
      failure = registration ? 13 : 5;
      const view = new DataView(event.buffer);
      view.setBigUint64(0, 101n, true); view.setInt16(8, -5, true);
      view.setUint16(10, registration ? 0x4041 : 0x8071, true);
      view.setUint32(12, result.eventFlags, true);
      view.setBigInt64(16, registration ? result.receiptData : result.eventData, true);
      return registration ? result.register : result.poll;
    },
    close() { order.push("close"); failure = 9; return result.close; },
    errno() { order.push("errno"); return failure; },
  };
  const now = () => { order.push("clock"); failure = 999; return { utc: "2026-11-14T00:00:00.000Z", monotonicMs: order.length }; };
  return { system, now, result, order };
}

test("syscall errno is captured before clocks on kqueue, registration, poll and close failure", () => {
  const f = syscalls();
  f.result.create = -1;
  expect(() => openExit(f.system, 101, f.now)).toThrow("kqueue failed");
  expect(f.order).toEqual(["kqueue", "errno", "clock"]);
  f.order.length = 0; f.result.create = 10; f.result.register = -1;
  try { openExit(f.system, 101, f.now); }
  catch (error) { expect(error).toMatchObject({ evidence: { errno: 13 } }); }
  expect(f.order.indexOf("errno")).toBe(f.order.indexOf("register") + 1);
  f.order.length = 0; f.result.register = 1;
  const subscription = openExit(f.system, 101, f.now);
  f.result.poll = -1;
  try { subscription.poll(); }
  catch (error) { expect(error).toMatchObject({ evidence: { errno: 5, raw: { hex: expect.any(String) } } }); }
  expect(f.order.indexOf("errno")).toBe(f.order.indexOf("poll") + 1);
  f.order.length = 0; f.result.close = -1;
  expect(() => subscription.close()).toThrow("close failed");
  subscription.close();
  expect(f.order).toEqual(["clock", "close", "errno", "clock"]);
  expect(subscription.closeReceipt).toMatchObject({ count: -1, errno: 9 });
});

test("registration error keeps primary receipt/status when its one close also fails", () => {
  const f = syscalls();
  f.result.receiptData = 13n; f.result.close = -1;
  let caught: unknown;
  try { openExit(f.system, 101, f.now); }
  catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(NativeExitError);
  expect(caught).toMatchObject({ message: "registration failed", evidence: { errno: 13, receipt: { data: "13" } },
    cleanup: { message: "close failed", evidence: { errno: 9 } } });
  expect(f.order.filter(item => item === "close")).toHaveLength(1);
});

test("malformed nonterminal and imprecise events preserve complete raw evidence without decoded attribution", () => {
  for (const data of [127n, 9007199254740993n]) {
    const f = syscalls();
    const subscription = openExit(f.system, 101, f.now);
    f.result.poll = 1; f.result.eventData = data;
    expect(() => subscription.poll()).toThrow("nonterminal or unrepresentable");
    try { subscription.poll(); }
    catch (error) { expect(error).toMatchObject({ evidence: { raw: { data: String(data), hex: expect.any(String) } } }); }
    subscription.close();
  }
});

test("injected native syscall adapter composes with the outer owner and keeps exact normal exit evidence", async () => {
  const f = syscalls();
  const native = fakeNative();
  const owner = new ExitOwner({ native: native.native, open: pid => openExit(f.system, pid, f.now), sink: { async write() {}, async close() {} } });
  const status = { status: "fail", exitCode: 23 };
  const actual = await owner.run(async () => { owner.attach({ pid: 101, birth: "7" }); f.result.poll = 1; owner.drain(); f.result.poll = 0; return status; });
  expect(actual).toBe(status);
  expect(owner.proof()).toMatchObject({ state: "settled", eventCount: 1 });
  expect(owner.records).toContainEqual(expect.objectContaining({ kind: "exit-poll", value: expect.objectContaining({ decoded: expect.objectContaining({ exitCode: 23, kernelMemoryExit: false }) }) }));
  expect(f.order.filter(item => item === "close")).toHaveLength(1);
});
