import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readdir, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { PreparationFlow, restorePackedBun } from "../../tests/shell-product/prepare-flow";
import { stageReleasedWaffle, stageWaffle, waffleCommits, waffleSourceRoot, writeWaffleSelection } from "../../tests/shell-product/waffle-stage";

const root = resolve(import.meta.dir, "../..");
function directory(name: string) {
  const value = process.env[name];
  assert.ok(value && isAbsolute(value), `Set absolute ${name}`);
  return value;
}
const destination = directory("SHELL_PRODUCT_INSTALL");
const commits = waffleCommits(process.env, await peer(root));
const { shellCommit, wafflePeer: waffle, waffleHostCommit } = commits;
const gitPeer = waffle.startsWith("git+");
const sourceVariant = gitPeer || waffleHostCommit !== commits.wafflePeerCommit
  ? { repository: directory("SHELL_PRODUCT_WAFFLE_REPOSITORY"), prepared: directory("SHELL_PRODUCT_PREPARED_WAFFLE") }
  : undefined;
const flow = new PreparationFlow();
let temporary: string | undefined;
let ownsDestination = false;
let prepared = false;

async function cleanup() {
  try { if (temporary) await rm(temporary, { recursive: true, force: true }); }
  finally { if (ownsDestination && (!prepared || flow.cancelled)) await rm(destination, { recursive: true, force: true }); }
}
async function peer(directory: string) {
  const metadata: unknown = await Bun.file(join(directory, "package.json")).json();
  assert.ok(metadata && typeof metadata === "object");
  const peers: unknown = Reflect.get(metadata, "peerDependencies");
  assert.ok(peers && typeof peers === "object");
  const value: unknown = Reflect.get(peers, "waffle");
  assert.ok(typeof value === "string", "Exact Waffle peer");
  return value;
}
async function detachPackage(directory: string) {
  const owned = `${directory}.shell-product-owned`;
  await cp(directory, owned, { recursive: true, dereference: true, errorOnExist: true, force: false });
  await rm(directory, { recursive: true, force: true });
  await rename(owned, directory);
}
const onSignal = () => { process.exitCode = 130; flow.cancel(new Error("Shell product preparation interrupted")); };
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(signal, onSignal);
const deadline = setTimeout(() => { process.exitCode = 1; flow.cancel(new Error("Shell product preparation deadline")); }, 10 * 60000);
async function prepareConsumer() {
  await mkdir(destination, { recursive: true });
  assert.deepEqual(await readdir(destination), [], "Never overwrite an existing consumer installation");
  ownsDestination = true;
  temporary = await mkdtemp(join(tmpdir(), "bw-sp-pack-"));
  console.log(JSON.stringify({ created: [destination, temporary, "package installation", "Shell guest build processes"], borrowed: sourceVariant ? [sourceVariant.repository, sourceVariant.prepared] : [], retainedOnSuccess: destination }));
  await flow.execute([process.execPath, "pm", "pack", "--destination", temporary, "--quiet"], root);
  const archive = (await readdir(temporary)).find(name => /^bun-wasm-.*\.tgz$/.test(name));
  assert.ok(archive, "Public Bun package archive");
  await cp(join(temporary, archive), join(destination, archive));
  if (gitPeer) waffleSourceRoot(directory("SHELL_PRODUCT_WAFFLE_REPOSITORY"), commits.wafflePeerCommit, true);
  await Bun.write(join(destination, "package.json"), JSON.stringify({ private: true, type: "module", dependencies: { "bun-wasm": `file:./${archive}`, "bash-web": `git+https://github.com/ShaulLavo/bash-web.git#${shellCommit}`, waffle, esbuild: "0.28.2", playwright: "1.64.1", typescript: "7.0.2", "@types/bun": "1.4.3" } }, null, 2));
  await flow.execute([process.execPath, "install", "--ignore-scripts"], destination);
  const installedWaffle = join(destination, "node_modules/waffle");
  const shell = join(destination, "node_modules/bash-web");
  await restorePackedBun(flow, { archive: join(temporary, archive), destination: join(destination, "node_modules/bun-wasm") });
  assert.equal(await peer(shell), waffle, "Reject mismatched public Shell before any fixture build");
  assert.equal(await peer(join(destination, "node_modules/bun-wasm")), waffle, "Reject mismatched public Bun before any fixture build");
  flow.check();
  await detachPackage(shell);
  if (!gitPeer)
    await stageReleasedWaffle(flow, { peer: waffle, archive: join(temporary, "waffle-release.tgz"), destination: installedWaffle });
  if (sourceVariant)
    await stageWaffle(flow, { ...sourceVariant, commit: waffleHostCommit, archive: join(temporary, "waffle-source.tar"), destination: installedWaffle, env: process.env });
  await mkdir(join(shell, "node_modules"), { recursive: true });
  await symlink("../../waffle", join(shell, "node_modules/waffle"), "dir");
  const env = { ...process.env, CARGO_TARGET_DIR: join(destination, "cargo") };
  await flow.execute([process.execPath, "scripts/build-worker.mjs"], shell, env);
  await flow.execute([process.execPath, "scripts/build-shell-browser.mjs"], shell, env);
  await flow.execute([process.execPath, "scripts/build-utilities.ts"], shell, env);
  flow.check();
  await writeWaffleSelection(destination, commits);
  prepared = true;
  console.log(`Prepared shell product installation at ${destination}. Caller owns removal after browser consumers finish.`);
}
try { await flow.run(prepareConsumer, cleanup); }
catch (error) {
  if (!flow.cancelled) throw error;
  console.error(error);
} finally {
  clearTimeout(deadline);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.off(signal, onSignal);
}
