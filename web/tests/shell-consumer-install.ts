import assert from "node:assert/strict";
import { cp, mkdir, readdir, readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { buildBrowserEntries, buildClassicWorker, resolveRuntimePackage } from "../../scripts/browser-build";

const shellCommit = "c92bd41da9ccc3fdc48b4d11a20288ce9969e2d5";
const waffleCommit = "b20fad173ebaa225cb87c51776f35edaaafd4a40";
const waffle = `git+https://github.com/ShaulLavo/waffle.git#${waffleCommit}`;
export type Execute = (command: string[], cwd: string, env?: NodeJS.ProcessEnv) => Promise<void>;
async function manifest(directory: string) {
  const value: unknown = await Bun.file(join(directory, "package.json")).json();
  assert.ok(value && typeof value === "object" && "version" in value && typeof value.version === "string", "package version");
  const peers: unknown = Reflect.get(value, "peerDependencies");
  assert.ok(peers && typeof peers === "object" && "waffle" in peers && typeof peers.waffle === "string", "package Waffle peer");
  return { version: value.version, peer: peers.waffle };
}
export async function installConsumer(root: string, directory: string, execute: Execute) {
  await mkdir(directory, { recursive: true });
  const metadata = await manifest(root);
  assert.equal(metadata.peer, waffle, "Bun must declare the accepted shared Waffle peer");
  await execute([process.execPath, "pm", "pack", "--destination", directory, "--quiet"], root);
  const archives = (await readdir(directory)).filter(file => /^bun-wasm-.*\.tgz$/.test(file));
  assert.equal(archives.length, 1, "one newly packed public Bun package");
  await Bun.write(join(directory, "package.json"), JSON.stringify({ private: true, type: "module", dependencies: {
    "bun-wasm": `file:./${archives[0]}`, "bash-web": `git+https://github.com/ShaulLavo/bash-web.git#${shellCommit}`, waffle,
    esbuild: "0.28.2", playwright: "1.64.1", typescript: "7.0.2", "@types/bun": "1.4.3",
  }, trustedDependencies: ["bun-wasm", "bash-web", "waffle", "esbuild"] }, null, 2));
  await execute([process.execPath, "install"], directory);
  const shell = join(directory, "node_modules/bash-web");
  // Git prepare emits workers only. Build the real runtime-backed shell guest too,
  // without demos, test guests or the compatibility corpus.
  await execute([process.execPath, "scripts/build-worker.mjs"], shell);
  const env = { ...process.env, CARGO_TARGET_DIR: join(directory, "cargo") };
  await execute([process.execPath, "scripts/build-shell-browser.mjs"], shell, env);
  await execute([process.execPath, "scripts/build-utilities.ts"], shell, env);
}
const digest = async (path: string) => new Bun.CryptoHasher("sha256").update(await Bun.file(path).bytes()).digest("hex");
export async function bundleConsumer(root: string, directory: string, output: string, execute: Execute) {
  const shell = join(directory, "node_modules/bash-web");
  const bun = join(directory, "node_modules/bun-wasm");
  const runtime = join(directory, "node_modules/waffle");
  const [shellMetadata, bunMetadata] = await Promise.all([shell, bun].map(manifest));
  assert.ok(shellMetadata && bunMetadata, "both installed consumer manifests");
  const runtimeMetadata: unknown = await Bun.file(join(runtime, "package.json")).json();
  assert.ok(runtimeMetadata && typeof runtimeMetadata === "object" && "version" in runtimeMetadata, "runtime manifest");
  assert.equal(shellMetadata.version, "0.0.91", "selected shell release");
  assert.equal(runtimeMetadata.version, "0.0.67", "selected shared runtime release");
  assert.equal(shellMetadata.peer, waffle);
  assert.equal(bunMetadata.peer, waffle);
  const lock = await readFile(join(directory, "bun.lock"), "utf8");
  assert.ok(lock.includes(shellCommit) && lock.includes(waffleCommit), "full Git commit pins in installed lockfile");
  for (const consumer of [shell, bun]) assert.equal(await realpath(join(resolveRuntimePackage(join(consumer, "src/index.ts")).path, "package.json")), await realpath(join(runtime, "package.json")), "one physical peer installation");
  const app = join(directory, "app");
  await cp(join(root, "tests/shell-consumer"), app, { recursive: true });
  await execute(["node", join(directory, "node_modules/typescript/bin/tsc"), "-p", app], directory);
  const entry = join(app, "main.ts");
  const built = await buildBrowserEntries([entry, join(app, "worker.ts"), join(app, "fs-worker.ts")], output);
  await buildClassicWorker(join(app, "sw.ts"), output, undefined, entry);
  await mkdir(join(output, "programs"), { recursive: true });
  const shellGuest = join(shell, "public/programs/shell-engine.wasm");
  const shellWorker = join(shell, "dist/shell-worker.js");
  await cp(shellGuest, join(output, "programs/shell-engine.wasm"));
  await cp(shellWorker, join(output, "shell-worker.js"));
  for (const utility of ["cat", "mkdir"]) await cp(join(shell, `dist/${utility}.wasm`), join(output, `programs/${utility}.wasm`));
  await Bun.write(join(output, "index.html"), '<!doctype html><title>Real shell and Bun</title><script type="module" src="./main.js"></script>');
  await Bun.write(join(output, "bundle-inputs.json"), JSON.stringify(built.metafile));
  return { shell: { commit: shellCommit, version: shellMetadata.version, guest: { path: "programs/shell-engine.wasm", sha256: await digest(shellGuest), bytes: Bun.file(shellGuest).size }, worker: { path: "shell-worker.js", sha256: await digest(shellWorker) } }, bun: { version: bunMetadata.version, archiveSha256: await digest(join(directory, `bun-wasm-${bunMetadata.version}.tgz`)), worker: "worker.js", publicExport: "bun-wasm/worker" }, waffle: { commit: waffleCommit, version: runtimeMetadata.version, worker: "fs-worker.js" }, installedLockSha256: await digest(join(directory, "bun.lock")), output: resolve(output) };
}
