import { test, expect } from "bun:test";
import inputs from "./inputs.lock.json";

test("all three release addons share the attested Oxc source and pinned generator", () => {
  expect(inputs.source.tag).toBe("crates_v0.94.0");
  expect(inputs.generator.version).toBe("3.2.0");
  expect(inputs.addons.map(addon => addon.addon)).toEqual(["parser", "transform", "minify"]);
  for (const addon of inputs.addons) expect(addon.minimumPages).toBeLessThanOrEqual(1024);
});
