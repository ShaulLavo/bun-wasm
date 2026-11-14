import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";

async function upstream(file: string) {
  const url = `https://raw.githubusercontent.com/actions/runner/v2.338.2/src/Runner.Worker/${file}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error("Pinned upstream source unavailable");
  const text = await response.text();
  return { url, text, sha256: createHash("sha256").update(text).digest("hex") };
}

function position(text: string, needle: string): number {
  const offset = text.indexOf(needle);
  if (offset < 0) throw new Error("Pinned upstream ordering changed");
  return text.slice(0, offset).split("\n").length;
}

async function main(): Promise<void> {
  const extension = await upstream("JobExtension.cs");
  const manager = await upstream("ActionManager.cs");
  const hook = await upstream("JobHookProvider.cs");
  const download = position(extension.text, "var prepareResult = await actionManager.PrepareActionsAsync");
  const adminHook = position(extension.text, "preJobSteps.Add(new JobExtensionRunner(runAsync: hookProvider.RunHook");
  const containers = position(extension.text, "preJobSteps.AddRange(prepareResult.ContainerSetupSteps)");
  const steps = position(extension.text, "foreach (var step in message.Steps)");
  if (!(download < adminHook && adminHook < containers && containers < steps)) throw new Error("Admin hook is not first in pre-job execution");
  const pulls = position(manager.text, "containerSetupSteps.Add(new JobExtensionRunner(runAsync: this.PullActionContainerAsync");
  const builds = position(manager.text, "containerSetupSteps.Add(new JobExtensionRunner(runAsync: this.BuildActionContainerAsync");
  const emptyEnvironment = position(hook.text, "environment: new Dictionary<string, string>");
  await writeFile("/work/reports/goals/ci-speed-20261114/runner-source-proof.json", JSON.stringify({
    version: "2.338.2", source: [extension, manager, hook].map(({ url, sha256 }) => ({ url, sha256 })),
    ordering: { download, adminHook, containers, steps, deferredPull: pulls, deferredBuild: builds, emptyHookEnvironment: emptyEnvironment },
    limitation: "Pre-hook action archives download and extract inside a private disposable guest. API binding precedes workflow, action and deferred container steps; it does not precede archive preparation.",
  }, null, 2));
}

main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : "Source proof failed"}\n`); process.exitCode = 1; });
