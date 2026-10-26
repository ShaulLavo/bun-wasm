import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const workflow = Bun.YAML.parse(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));
const steps = workflow.jobs.rust.steps;
const byId = (id: string) => steps.find((step: { id?: string }) => step.id === id);
const named = (name: string) => steps.find((step: { name?: string }) => step.name === name);
const position = (name: string) => steps.findIndex((step: { name?: string }) => step.name === name);

test("sysroot and prebuild restores use effective inputs and have bounded compatible fallbacks", () => {
  for (const id of ["sysroot-cache", "jsc-prebuild-cache", "jsc-cargo-cache"]) {
    const restore = byId(id);
    expect(restore, id).toBeDefined();
    expect(restore.with["restore-keys"], id).toBeTruthy();
    expect(restore.with.key).not.toContain("'bun.lock'");
    expect(restore.with.key).not.toContain("'env.sh'");
    expect(restore.with.key).toContain("outputs.");
  }
});

test("completed caches are saved before later validation can fail or time out", () => {
  expect(position("Save the verified sysroot cache")).toBeGreaterThan(position("Build patched WASI sysroot"));
  expect(position("Save the verified sysroot cache")).toBeLessThan(position("Blocking native checks with one owned JSC prebuild"));
  expect(position("Save the JSC prebuild cache once per input revision")).toBeLessThan(position("Blocking JSC embedding and allocation checks"));
  expect(position("Save the JSC Cargo cache once per input revision")).toBeLessThan(position("Blocking JSC embedding and allocation checks"));
  expect(position("Save the complete native fallback once per input revision")).toBeLessThan(position("Build native fixtures after the cache checkpoint"));
  expect(position("Save the refined native Cargo cache once per input revision")).toBeLessThan(position("Blocking Web guest cases (QuickJS and host engine)"));
  expect(named("Save the JSC prebuild cache once per input revision").if).toContain("!cancelled()");
  expect(named("Save the JSC prebuild cache once per input revision").if).toContain("outputs.jsc-ready == 'true'");
});
