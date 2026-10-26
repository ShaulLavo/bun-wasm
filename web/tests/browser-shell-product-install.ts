import assert from "node:assert/strict";
import { cp, mkdir, readFile, realpath, symlink } from "node:fs/promises";
import { join } from "node:path";
import { buildBrowserEntries, buildClassicWorker, resolveRuntimePackage } from "../../scripts/browser-build";
import { readWaffleSelection, waffleCommits } from "../../tests/shell-product/waffle-stage";

export async function bundleProduct(root: string, installation: string, output: string) {
  const shell = join(installation, "node_modules/bash-web");
  const bun = join(installation, "node_modules/bun-wasm");
  const runtime = join(installation, "node_modules/waffle");
  const packages = await Promise.all([shell, bun, runtime].map(async directory => {
    const metadata: unknown = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
    assert.ok(metadata && typeof metadata === "object");
    return metadata;
  }));
  const peer = (metadata: object) => {
    const peers: unknown = Reflect.get(metadata, "peerDependencies");
    assert.ok(peers && typeof peers === "object");
    const value: unknown = Reflect.get(peers, "waffle");
    assert.equal(typeof value, "string");
    return value;
  };
  const [shellMetadata, bunMetadata] = packages;
  assert.ok(shellMetadata && bunMetadata);
  assert.equal(peer(shellMetadata), peer(bunMetadata), "Shell and Bun must declare the same exact Waffle peer. Do not patch installed manifests.");
  const commits = waffleCommits(process.env);
  const { shellCommit, wafflePeerCommit } = commits;
  const lock = await readFile(join(installation, "bun.lock"), "utf8");
  assert.ok(lock.includes(shellCommit) && lock.includes(wafflePeerCommit), "Prepared installation must retain both exact Git pins");
  assert.equal(peer(bunMetadata), `git+https://github.com/ShaulLavo/waffle.git#${wafflePeerCommit}`);
  const waffleSelection = await readWaffleSelection(installation, commits);
  for (const consumer of [shell, bun]) assert.equal(await realpath(join(resolveRuntimePackage(join(consumer, "src/index.ts")).path, "package.json")), await realpath(join(runtime, "package.json")), "One physical runtime peer");
  const app = join(output, "../app");
  await cp(join(root, "tests/shell-product"), app, { recursive: true, errorOnExist: true, force: false, filter: path => !path.endsWith("fixtures.ts") && !path.endsWith(".test.ts") });
  await symlink(join(installation, "node_modules"), join(app, "node_modules"), "dir");
  const entries = ["main.ts", "worker.ts", "fs-worker.ts"].map(name => join(app, name));
  const exports: unknown = Reflect.get(shellMetadata, "exports");
  const tail = Boolean(exports && typeof exports === "object" && "./utilities/tail" in exports);
  if (tail) await Bun.write(join(app, "tail-install.ts"), 'import type { Runtime } from "waffle"; import { installTail } from "bash-web/utilities/tail"; export const install = (runtime: Runtime) => installTail(runtime, { wasmUrl: "./programs/tail.wasm", workerUrl: "./shell-worker.js" });');
  await buildBrowserEntries(tail ? entries.concat([join(app, "tail-install.ts")]) : entries, output);
  await buildClassicWorker(join(app, "sw.ts"), output, undefined, entries[0]);
  await mkdir(join(output, "programs"), { recursive: true });
  for (const name of ["cat", "grep"]) await cp(join(shell, `dist/${name}.wasm`), join(output, `programs/${name}.wasm`));
  if (tail) await cp(join(shell, "dist/tail.wasm"), join(output, "programs/tail.wasm"));
  await Bun.write(join(output, "capabilities.json"), JSON.stringify({ tail }));
  await cp(join(shell, "public/programs/shell-engine.wasm"), join(output, "programs/shell-engine.wasm"));
  await cp(join(shell, "dist/shell-worker.js"), join(output, "shell-worker.js"));
  await Bun.write(join(output, "index.html"), '<!doctype html><title>Shell product integration</title><script type="module" src="./main.js"></script>');
  return { app, packages, ...waffleSelection };
}
