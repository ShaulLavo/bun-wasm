import { readFileSync } from "node:fs";

export function expandedCiWorkflow(): string {
  const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
  const setup = read(".github/actions/jsc-setup/action.yml");
  const prebuild = read(".github/actions/jsc-prebuild/action.yml");
  const key = setup.match(/^        CACHE_KEY: (.+)$/m)?.[1];
  const prefix = setup.match(/^        CACHE_PREFIX: (.+)$/m)?.[1];
  if (!key || !prefix) throw new Error("Missing effective JSC cache identity");
  const actionSteps = (source: string) => {
    const steps = source.split("  steps:\n")[1];
    if (!steps) throw new Error("Missing composite steps");
    return steps.replace(/^/gm, "  ").trimEnd() + "\n";
  };
  const expand = (source: string) => source.replace(
    /^      - uses: \.\/\.github\/actions\/jsc-(setup|prebuild)\n(?: {8,}.+\n)*/gm,
    (_step, action: string) => actionSteps(action === "setup" ? setup : prebuild),
  );
  const sharedSetup = read(".github/actions/shared-jsc-setup/action.yml");
  const sharedBuild = read(".github/actions/shared-jsc-prebuild/action.yml");
  const sharedKey = sharedSetup.match(/^        JSC_KEY: (.+)$/m)?.[1];
  if (!sharedKey) throw new Error("Missing effective shared JSC cache identity");
  const ci = read(".github/workflows/ci.yml");
  const runner = ci.match(/^    runs-on: &pc-runner (.+)$/m)?.[1];
  if (!runner) throw new Error("Missing centralized PC runner policy");
  const shared = ci.replace("runs-on: &pc-runner ", "runs-on: ").replaceAll("runs-on: *pc-runner", `runs-on: ${runner}`).replace(
    /^      - uses: \.\/\.github\/actions\/shared-jsc-(setup|prebuild)\n(?: {8,}.+\n)*/gm,
    (_step, action: string) => actionSteps(action === "setup" ? sharedSetup : sharedBuild)
      .replaceAll("${{ inputs.key }}", sharedKey)
      .replaceAll("${{ inputs.expected-key }}", "${{ needs.shared-jsc-identity.outputs.key }}")
      .replaceAll("inputs.shared-native", "needs.selection.outputs.shared-native"),
  );
  return expand(shared)
    .replaceAll("${{ inputs.key }}", key)
    .replaceAll("${{ inputs.prefix }}", prefix)
    .replaceAll("${{ inputs.expected-key }}", "${{ needs.jsc-identity.outputs.key }}")
    .replaceAll("${{ steps.prebuild.outputs.manifest-sha256 }}", "${{ steps.jsc-artifact.outputs.manifest-sha256 }}");
}
