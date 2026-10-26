import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readdir, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { PreparationFlow } from "../../tests/shell-product/prepare-flow";
import { stageWaffle } from "../../tests/shell-product/waffle-stage";

const root = resolve(import.meta.dir, "../..");
function directory(name: string) {
  const value = process.env[name];
  assert.ok(value && isAbsolute(value), `Set absolute ${name}`);
  return value;
}
const destination = directory("SHELL_PRODUCT_INSTALL");
function commit(name: string) {
  const value = process.env[name];
  assert.ok(value && /^[a-f0-9]{40}$/.test(value), `Set full ${name}`);
  return value;
}
const shellCommit = commit("SHELL_PRODUCT_SHELL_COMMIT");
const waffleCommit = commit("SHELL_PRODUCT_WAFFLE_COMMIT");
const waffleRepository = directory("SHELL_PRODUCT_WAFFLE_REPOSITORY");
const preparedWaffle = directory("SHELL_PRODUCT_PREPARED_WAFFLE");
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
  return Reflect.get(peers, "waffle");
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
  console.log(JSON.stringify({ created: [destination, temporary, "package installation", "Shell guest build processes"], borrowed: [preparedWaffle], retainedOnSuccess: destination }));
  await flow.execute([process.execPath, "pm", "pack", "--destination", temporary, "--quiet"], root);
  const archive = (await readdir(temporary)).find(name => /^bun-wasm-.*\.tgz$/.test(name));
  assert.ok(archive, "Public Bun package archive");
  await cp(join(temporary, archive), join(destination, archive));
  const waffle = `git+https://github.com/ShaulLavo/waffle.git#${waffleCommit}`;
  await Bun.write(join(destination, "package.json"), JSON.stringify({ private: true, type: "module", dependencies: { "bun-wasm": `file:./${archive}`, "bash-web": `git+https://github.com/ShaulLavo/bash-web.git#${shellCommit}`, waffle, esbuild: "0.28.2", playwright: "1.64.1", typescript: "7.0.2", "@types/bun": "1.4.3" } }, null, 2));
  await flow.execute([process.execPath, "install", "--ignore-scripts"], destination);
  const installedWaffle = join(destination, "node_modules/waffle");
  const shell = join(destination, "node_modules/bash-web");
  assert.equal(await peer(shell), waffle, "Reject mismatched public Shell before any fixture build");
  assert.equal(await peer(join(destination, "node_modules/bun-wasm")), waffle, "Reject mismatched public Bun before any fixture build");
  flow.check();
  await detachPackage(shell);
  await stageWaffle(flow, { repository: waffleRepository, commit: waffleCommit, archive: join(temporary, "waffle-source.tar"), destination: installedWaffle, prepared: preparedWaffle, env: process.env });
  await mkdir(join(shell, "node_modules"), { recursive: true });
  await symlink("../../waffle", join(shell, "node_modules/waffle"), "dir");
  const env = { ...process.env, CARGO_TARGET_DIR: join(destination, "cargo") };
  await flow.execute([process.execPath, "scripts/build-worker.mjs"], shell, env);
  await flow.execute([process.execPath, "scripts/build-shell-browser.mjs"], shell, env);
  await flow.execute([process.execPath, "scripts/build-utilities.ts"], shell, env);
  flow.check();
  prepared = true;
  console.log(`Prepared public package consumer at ${destination}. Caller owns removal after browser consumers finish.`);
}
try { await flow.run(prepareConsumer, cleanup); }
catch (error) {
  if (!flow.cancelled) throw error;
  console.error(error);
} finally {
  clearTimeout(deadline);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.off(signal, onSignal);
}
