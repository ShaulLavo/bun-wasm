test("preload runs before collection and hooks before tests", () => {
  expect(globalThis.preloadLoaded).toBe(true);
  expect(globalThis.preloadHookRan).toBe(true);
  expect(process.report.getReport().header).toEqual({});
  expect(typeof Bun.unsafe.gcAggressionLevel).toBe("function");
});
