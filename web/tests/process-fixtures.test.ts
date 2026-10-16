import { expect, test } from "bun:test";
import { processFixture, type ProcessFixture } from "./process-fixtures";

test.each(["exit", "default", "handled", "handling", "handled-trap", "unrunnable"] as ProcessFixture[])("original preview1 %s fixture validates without toolchains", mode => {
  expect(WebAssembly.validate(processFixture(mode))).toBe(true);
});
function instantiate(mode: ProcessFixture, signal = 0) {
  let writes = 0, defaultSignal = 0;
  const instance = new WebAssembly.Instance(new WebAssembly.Module(processFixture(mode)), {
    wasi_snapshot_preview1: { fd_write: () => { writes++; return 0; } },
    runtime_proc: { interrupted: () => signal, default_signal: (value: number) => { defaultSignal = value; } },
  });
  return { start: instance.exports._start as () => void, writes: () => writes, defaultSignal: () => defaultSignal };
}
test("default CPU cancellation explicitly traps even if default_signal mistakenly returns", () => {
  const guest = instantiate("default", 2);
  expect(guest.start).toThrow(WebAssembly.RuntimeError);
  expect(guest.defaultSignal()).toBe(2);
  expect(guest.writes()).toBe(1);
});
test("guest can consume a handled signal and exit normally without default action", () => {
  const guest = instantiate("handled", 2);
  guest.start(); expect(guest.defaultSignal()).toBe(0); expect(guest.writes()).toBe(1);
});
test("active handler still takes the explicit default trap for uncatchable KILL", () => {
  const guest = instantiate("handling", 9);
  expect(guest.start).toThrow(WebAssembly.RuntimeError); expect(guest.defaultSignal()).toBe(9);
});
test("handled signal followed by unrelated trap is distinguishable from default action", () => {
  const guest = instantiate("handled-trap", 2);
  expect(guest.start).toThrow(WebAssembly.RuntimeError); expect(guest.defaultSignal()).toBe(0);
});
