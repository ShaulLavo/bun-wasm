import { expect, test } from "bun:test";
import { vmMemorySettings } from "./resources.ts";

test("VM admission reserves its known memory without raising ceilings or changing shared queue policy", () => {
  const settings = { memoryReserveMiB: 2048, growthReserveMiB: 512, stopGraceSeconds: 10,
    classes: { suite: { ceilingMiB: 8192, estimateMiB: 4096 }, browser: { ceilingMiB: 10240, estimateMiB: 3584 }, light: { ceilingMiB: 2048, estimateMiB: 1280 } } };
  expect(vmMemorySettings(settings)).toEqual({ ...settings, classes: { ...settings.classes,
    suite: { ceilingMiB: 8192, estimateMiB: 8192 }, browser: { ceilingMiB: 10240, estimateMiB: 10240 } } });
  expect(settings.classes.suite.estimateMiB).toBe(4096);
  expect(settings.classes.browser.estimateMiB).toBe(3584);
});

test.each([null, {}, { classes: {} }, { classes: { suite: { ceilingMiB: 4096 }, browser: { ceilingMiB: 10240 } } }])("invalid or insufficient VM budget %j is refused", value => {
  expect(() => vmMemorySettings(value)).toThrow();
});
