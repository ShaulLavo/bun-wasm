import { expect, test } from "bun:test";
import { examples } from "../src/examples";
import { demo, demos } from "../src/playground/demos";
import { copy } from "../src/playground/showcase-copy";

test("every demo runs a seeded example and restores only seeded files", () => {
  expect(demos.map(entry => entry.id)).toEqual(Object.keys(copy.demos) as typeof demos[number]["id"][]);
  for (const entry of demos) {
    expect(entry.files[0]).toBe(entry.file);
    for (const file of entry.files) expect(Object.keys(examples)).toContain(file);
  }
});

test("demo ids from the address resolve, unknown ones do not", () => {
  expect(demo("serve")?.file).toBe("serve.ts");
  expect(demo("test")?.files).toEqual(["math.test.ts", "math.ts"]);
  expect(demo("nope")).toBeUndefined();
  expect(demo(null)).toBeUndefined();
});

test("the Bun.serve demo listens on a fixed port so its preview and Restart find it", () => {
  expect(examples["serve.ts"]).toContain("port: 3000");
});
