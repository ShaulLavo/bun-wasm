import { setDefaultTimeout } from "bun:test";
setDefaultTimeout(2000);
test.serial("preload runs before collection and hooks before tests", () => {
  expect(globalThis.preloadLoaded).toBe(true);
  expect(globalThis.preloadHookRan).toBe(true);
  expect(process.report.getReport().header).toEqual({});
  expect(Bun.unsafe.gcAggressionLevel).toBeUndefined();
});
describe.skipIf(true).concurrent("skipped parallel group", () => {
  test("body must not run", () => { throw new Error("skip was lost"); });
});
