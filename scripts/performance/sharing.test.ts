import { expect, test } from "bun:test";
import { controlFiles } from "./sharing-patch";

test("diagnostic patch matches released compiled-plan handoff and rejects memory groups", async () => {
  const files = await controlFiles(process.cwd());
  expect(files.map(file => file.path)).toEqual(["src/assets.ts", "web/src/bun-executor.ts"]);
  expect(files[0]!.modified).toContain("diagnosticLinkSource: source");
  expect(files[1]!.modified).toContain("await prepareLinkPlan(req.diagnosticLinkSource)");
  expect(files[1]!.modified).toContain('if (req.memoryGroup) throw');
});
