import { preparationEvents } from "./sharing-controls";
import { expect, test } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { controlFiles, writeControlPatch } from "./sharing-patch";

test("diagnostic patch matches released compiled-plan handoff and rejects memory groups", async () => {
  const files = await controlFiles(process.cwd());
  expect(files.map(file => file.path)).toEqual(["src/assets.ts", "web/src/bun-executor.ts"]);
  expect(files[0]!.modified).toContain("diagnosticLinkSource: source");
  expect(files[1]!.modified).toContain("await prepareLinkPlan(request.diagnosticLinkSource)");
  expect(files[1]!.modified).toContain('if (req.memoryGroup) throw');
});

test("control patch passes git apply --check against current source", async () => {
  const root = await mkdtemp("/work/tmp/bun-wasm-sharing-check-");
  try {
    const patch = await writeControlPatch(process.cwd(), root);
    expect(await readFile(patch, "utf8")).toContain("linkPlan: undefined, diagnosticLinkSource: source");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("worker preparation records require ordered durations and explicit source bytes", () => {
  expect(preparationEvents({ output: '[bunwasm-perf] {"event":"unshared-prepare","beforeMs":3,"afterMs":8,"sourceBytes":42}\n' })).toHaveLength(1);
  expect(preparationEvents({ output: '[bunwasm-perf] {"event":"unshared-prepare","beforeMs":8,"afterMs":3,"sourceBytes":42}\n' })).toHaveLength(0);
});
