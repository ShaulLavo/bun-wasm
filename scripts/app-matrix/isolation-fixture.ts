import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { quickjsPair } from "../../tests/package/quickjs-plan-fixture";
import { sha256 } from "./registry.mjs";

/** Synthetic validation inputs only. The no-op launcher never executes this pair. */
export function stageIsolationInputs(root: string, directory: string): void {
  const { core, side } = quickjsPair();
  const files = [["bun.wasm", core], ["quickjs.wasm", side]] as const;
  for (const [name, bytes] of files) writeFileSync(join(directory, "dist", name), bytes);
  writeFileSync(join(directory, "web/dist/engine-builds.json"), JSON.stringify(Object.fromEntries(files.map(([name, bytes]) => [name, sha256(bytes)]))));
  mkdirSync(join(directory, "src"));
  copyFileSync(join(root, "src/engine-kind.ts"), join(directory, "src/engine-kind.ts"));
}
