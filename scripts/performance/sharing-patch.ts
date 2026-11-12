import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ownedCommand } from "../goals-matrix/lifetime";

const changes = [
  { path: "src/assets.ts", replacements: [
    ["type SharedLinkPlan }", "type SharedLinkPlan, type LinkPlanSource }"],
    ["readonly linkPlan: SharedLinkPlan | undefined;", "readonly linkPlan: SharedLinkPlan | undefined;\n  readonly diagnosticLinkSource?: LinkPlanSource;"],
    ["linkPlan: plan.shared, memoryLimitBytes:", "linkPlan: plan.shared, diagnosticLinkSource: source, memoryLimitBytes:"],
  ] },
  { path: "web/src/bun-executor.ts", replacements: [
    ["import { adoptLinkPlan,", "import { prepareLinkPlan, type LinkPlanSource, adoptLinkPlan,"],
    ["linkPlan?: SharedLinkPlan;", "linkPlan?: SharedLinkPlan;\n  diagnosticLinkSource?: LinkPlanSource;"],
    ["const plan = adoptLinkPlan(request.linkPlan);", `if (req.memoryGroup) throw new Error("Diagnostic control only supports split profile");
      if (!req.diagnosticLinkSource) throw new Error("Diagnostic link source missing");
      const beforeMs = performance.now();
      const plan = await prepareLinkPlan(req.diagnosticLinkSource);
      const bytes = req.diagnosticLinkSource.core.source.byteLength + req.diagnosticLinkSource.libraries.reduce((sum, library) => sum + library.source.byteLength, 0);
      host.postMessage({ type: "stderr", data: new TextEncoder().encode("[bunwasm-perf] " + JSON.stringify({ event: "unshared-prepare", beforeMs, afterMs: performance.now(), sourceBytes: bytes }) + "\\n") });`],
  ] },
];
export async function controlFiles(root: string) {
  return Promise.all(changes.map(async change => {
    const original = await readFile(join(root, change.path), "utf8");
    let modified = original;
    for (const [before, after] of change.replacements) {
      if (!before || after === undefined || modified.split(before).length !== 2) throw new Error(`Control patch context changed in ${change.path}`);
      modified = modified.replace(before, after);
    }
    return { path: change.path, original, modified };
  }));
}
export async function writeControlPatch(root: string, output: string) {
  await mkdir(output, { recursive: true });
  const files = await controlFiles(root);
  const patches: string[] = [];
  for (const [index, file] of files.entries()) {
    const before = join(output, `before-${index}`), after = join(output, `after-${index}`);
    await writeFile(before, file.original); await writeFile(after, file.modified);
    const process = Bun.spawn(["diff", "-u", "--label", `a/${file.path}`, "--label", `b/${file.path}`, before, after], { stdout: "pipe" });
    patches.push(await new Response(process.stdout).text());
    if (await process.exited !== 1) throw new Error("Expected diagnostic diff");
  }
  const patch = join(output, "unshared-link-plan.patch");
  await writeFile(patch, patches.join(""));
  await ownedCommand(["git", "apply", "--check", patch], undefined, 10000);
  return patch;
}
