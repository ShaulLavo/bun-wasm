import { cp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ownedCommand, withSignals } from "../goals-matrix/lifetime";
import { writeControlPatch } from "./sharing-patch";
import { canonical, sha256, treeInventory } from "./input";

async function prepare(args: string[], signal: AbortSignal) {
  const [directory, delivery, pair, receipt] = args.map(value => resolve(value));
  if (!directory || !delivery || !pair || !receipt || args.length !== 4) throw new Error("Usage: prepare-sharing.ts EMPTY_SCRATCH CANONICAL_DELIVERY SM_PAIR SM_RECEIPT");
  const source = join(directory, "source");
  await mkdir(source);
  const files = (await ownedCommand(["git", "ls-files", "-z"])).split("\0").filter(Boolean);
  for (const file of files) await cp(file, join(source, file), { recursive: true });
  await cp(".git", join(source, ".git"));
  for (const path of ["node_modules", "web/node_modules", "sandbox/node_modules"]) await symlink(resolve(path), join(source, path));
  const original = treeInventory(source, [".git", "node_modules", "web/node_modules", "sandbox/node_modules"]);
  const patch = await writeControlPatch(process.cwd(), directory);
  const prepareCommand = [process.execPath, resolve("scripts/performance/prepare-lifecycle.ts"), delivery];
  const cwd = process.cwd();
  const previousWorkTree = process.env.GIT_WORK_TREE;
  try {
    process.chdir(source); process.env.GIT_WORK_TREE = source;
    for (const mode of ["shared", "unshared"]) {
      await applyMode(mode, patch, signal);
      const output = join(directory, mode);
      await mkdir(output);
      await ownedCommand(prepareCommand.concat([output, pair, receipt]), signal, 240000, true);
      const host = join(output, "host/lifecycle-host.json");
      const metadata = JSON.parse(await readFile(host, "utf8"));
      await writeFile(host, JSON.stringify({ ...metadata, sharing: mode, controlPatch: mode === "unshared" ? sha256(await readFile(patch)) : null }));
    }
  } finally { process.chdir(cwd); if (previousWorkTree === undefined) delete process.env.GIT_WORK_TREE; else process.env.GIT_WORK_TREE = previousWorkTree; }
  const [shared, unshared] = await Promise.all(["shared", "unshared"].map(mode => readFile(join(directory, mode, "host/engine-builds.json"), "utf8")));
  if (canonical(JSON.parse(shared!)) !== canonical(JSON.parse(unshared!))) throw new Error("Sharing pair changed guest fingerprints");
  await writeFile(join(directory, "sharing-inputs.json"), JSON.stringify({ original, guestFingerprints: JSON.parse(shared!), patch: sha256(await readFile(patch)),
    scope: "Same source; default split. Shared prepares on page and adopts in workers. Unshared additionally retains/clones source and prepares in each worker. Browser internal caches remain uncontrolled." }));
}
if (import.meta.main) await withSignals(signal => prepare(process.argv.slice(2), signal));

async function applyMode(mode: string, patch: string, signal: AbortSignal) {
  if (mode === "unshared") await ownedCommand(["git", "apply", patch], signal);
}
