import { spawnSync } from "node:child_process";
import { basename } from "node:path";
import { parseCheck } from "./test-checks";

export function checkInputPaths(check: ReturnType<typeof parseCheck>): string[] {
  if (check.owner === "native") return [`${check.path}/`];
  return check.owner === "runtime" ? [check.path] : [];
}

export function matchesCheckInput(path: string, inputs: readonly string[]): boolean {
  return inputs.some(input => input.endsWith("/") ? path.startsWith(input) : path === input);
}

export function nativeCheckInputsAt(ref: string): string[] {
  if (/^0{40}$/.test(ref)) return [];
  const result = spawnSync("git", ["grep", "--no-color", "--no-textconv", "--no-column", "--full-name", "--no-line-number", "--null", "-e", "", ref, "--", "checks/"], { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status === 1) return [];
  if (result.status !== 0) throw new Error(`Cannot read check inputs at ${ref}: ${result.stderr}`);
  const manifests = new Map<string, string[]>();
  for (const line of result.stdout.trimEnd().split("\n")) {
    const separator = line.indexOf("\0");
    const path = line.slice(ref.length + 1, separator);
    if (separator < 0 || !/^checks\/[a-z0-9-]+\.json$/.test(path)) throw new Error(`Unsafe check manifest at ${ref}: ${path}`);
    manifests.set(path, (manifests.get(path) ?? []).concat([line.slice(separator + 1)]));
  }
  return Array.from(manifests).flatMap(([path, lines]) => {
    const check = parseCheck(JSON.parse(lines.join("\n")), basename(path));
    const inputs = checkInputPaths(check);
    return inputs.length ? inputs.concat([path]) : [];
  });
}
