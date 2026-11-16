import { readFileSync } from "node:fs";

function inputs(step: string): Map<string, string> {
  return new Map(Array.from(step.matchAll(/^          ([\w-]+): (.+)$/gm), match => [match[1]!, match[2]!.replace(/^'(.*)'$/, "$1")]));
}

function expandedSteps(action: string, call: string): string {
  const source = readFileSync(new URL(`../../.github/actions/${action}/action.yml`, import.meta.url), "utf8");
  const body = source.split("  steps:\n")[1];
  if (!body) throw new Error(`Missing ${action} composite steps`);
  const values = inputs(call);
  let result = body.replace(/^/gm, "  ").trimEnd() + "\n";
  for (const [name, value] of values) {
    result = result.replaceAll(`\${{ inputs.${name} }}`, value);
    result = result.replaceAll(`inputs.${name}`, value.startsWith("${{") ? value.slice(3, -2).trim() : `'${value}'`);
  }
  return result.split(/(?=^      - )/m).map(foldCondition).join("");
}

function foldCondition(step: string): string {
  const match = step.match(/^        if: '([^']+)' (==|!=) '([^']+)'(?: && (.+))?\n/m);
  if (!match) return step;
  const enabled = match[2] === "==" ? match[1] === match[3] : match[1] !== match[3];
  if (!enabled) return "";
  return foldCondition(step.replace(match[0], match[4] ? `        if: ${match[4]}\n` : ""));
}

export function expandNativeActions(source: string): string {
  return source.replace(/^      - uses: \.\/\.github\/actions\/(native-setup|native-seed|native-production)\n(?: {8,}.+\n)*/gm,
    (step, action: string) => expandedSteps(action, step))
    .replaceAll("steps.native-setup.outputs.host-tools", "steps.host-tools.outputs.hash")
    .replaceAll("steps.native-setup.outputs.native-inputs", "steps.native-inputs.outputs.hash")
    .replaceAll("steps.native-setup.outputs.object-key", "steps.rust-objects.outputs.cache-primary-key")
    .replaceAll("steps.native-seed.outputs.cargo-hit", "steps.native-cargo-cache.outputs.cache-hit")
    .replaceAll("steps.native-seed.outputs.cargo-matched", "steps.native-cargo-cache.outputs.cache-matched-key")
    .replaceAll("steps.native-seed.outputs.legacy-hit", "steps.native-cache.outputs.cache-hit");
}
