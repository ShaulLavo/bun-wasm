import { canonical, sha256, treeInventory } from "./input";

export type Workload = "next" | "vite";
type PreviewBrowser = "chrome" | "firefox";
type LifecycleArm =
  | { kind: "native"; runtime: "node" | "bun"; browser: PreviewBrowser | null }
  | { kind: "goals-browser"; engine: "browser" | "quickjs" | "jsc" | "spidermonkey"; browser: PreviewBrowser; profile: "split" };
export interface LifecycleCell { id: string; workload: Workload; arm: LifecycleArm }
export interface Bracket { beforeMs: number; afterMs: number }
export type LifecycleOutcome =
  | { kind: "next"; exitCode: number; outputs: { path: string; bytes: number | null; reason?: string }[] }
  | { kind: "vite"; listening: Bracket; rendered: Bracket; counter: Bracket; before: string; after: string };
export const nextOutputs = [".next/BUILD_ID", ".next/build-manifest.json", ".next/server/pages/index.html"];
export const mutableRoots: Record<Workload, string[]> = {
  next: [".next", "next-env.d.ts"],
  vite: ["node_modules/.vite", "node_modules/.vite-temp"],
};
export function immutableIdentity(root: string, workload: Workload): string {
  return sha256(canonical(treeInventory(root, mutableRoots[workload])));
}
export function validateLifecycle(outcome: LifecycleOutcome): void {
  if (outcome.kind === "next") {
    if (outcome.exitCode !== 0) throw new Error(`Next exited ${outcome.exitCode}`);
    if (nextOutputs.some(path => !outcome.outputs.some(output => output.path === path && output.bytes !== null && output.bytes > 0))) throw new Error("Next expected build outputs are missing");
    return;
  }
  if (!/\b0\b/.test(outcome.before) || outcome.after !== outcome.before.replace(/\b0\b/, "1")) throw new Error("Vite counter did not change from zero to one");
  for (const bracket of [outcome.listening, outcome.rendered, outcome.counter]) {
    if (!Number.isFinite(bracket.beforeMs) || bracket.afterMs < bracket.beforeMs) throw new Error("Invalid lifecycle observation bracket");
  }
}
export function baseMatrix(): LifecycleCell[] {
  const cells: LifecycleCell[] = [];
  for (const workload of ["next", "vite"] satisfies Workload[]) {
    for (const browser of ["chrome", "firefox"] satisfies PreviewBrowser[]) {
      for (const engine of ["browser", "quickjs", "jsc", "spidermonkey"] as const) cells.push({ id: `${workload}-${browser}-${engine}-split`, workload, arm: { kind: "goals-browser", engine, browser, profile: "split" } });
    }
    for (const runtime of ["node", "bun"] as const) {
      const previews: (PreviewBrowser | null)[] = workload === "next" ? [null] : ["chrome", "firefox"];
      for (const browser of previews) cells.push({ id: `${workload}-native-${runtime}${browser ? `-${browser}` : ""}`, workload, arm: { kind: "native", runtime, browser } });
    }
  }
  return cells;
}
