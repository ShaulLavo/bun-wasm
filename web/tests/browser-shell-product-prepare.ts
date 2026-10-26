import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, rename, rm, symlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
function directory(name: string) {
  const value = process.env[name];
  assert.ok(value && isAbsolute(value), `Set absolute ${name}`);
  return value;
}
const destination = directory("SHELL_PRODUCT_INSTALL");
const shellCommit = process.env.SHELL_PRODUCT_SHELL_COMMIT;
const waffleCommit = process.env.SHELL_PRODUCT_WAFFLE_COMMIT;
const preparedWaffle = directory("SHELL_PRODUCT_PREPARED_WAFFLE");
assert.match(shellCommit ?? "", /^[a-f0-9]{40}$/);
assert.match(waffleCommit ?? "", /^[a-f0-9]{40}$/);
const children = new Set<ChildProcess>();
let temporary: string | undefined;
let ownsDestination = false;
let prepared = false;
let cleaned: Promise<void> | undefined;

function missingProcess(error: unknown) {
  return error && typeof error === "object" && "code" in error && error.code === "ESRCH";
}
function kill(child: ChildProcess) {
  if (!child.pid) return;
  try { process.kill(-child.pid, "SIGKILL"); }
  catch (error) { if (!missingProcess(error)) throw error; }
}
function execute(command: string[], cwd: string, env = process.env) {
  const [program, ...args] = command;
  assert.ok(program);
  return new Promise<void>((resolve, reject) => {
    const child = spawn(program, args, { cwd, env, stdio: "inherit", detached: true });
    children.add(child);
    child.once("error", reject);
    child.once("close", code => {
      kill(child);
      children.delete(child);
      if (code === 0) resolve();
      else reject(new Error(`${command.join(" ")} exited ${code}`));
    });
  });
}
function stop(child: ChildProcess) {
  return new Promise<void>(resolve => { child.once("close", () => resolve()); kill(child); });
}
function cleanup() {
  return cleaned ??= (async () => {
    await Promise.all(Array.from(children, stop));
    if (temporary) await rm(temporary, { recursive: true, force: true });
    if (ownsDestination && !prepared) await rm(destination, { recursive: true, force: true });
    assert.equal(children.size, 0, "Owned preparation processes stopped");
  })();
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
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(signal, () => void cleanup().finally(() => process.exit(130)));
const deadline = setTimeout(() => void cleanup().finally(() => process.exit(1)), 10 * 60000);
try {
  await mkdir(destination, { recursive: true });
  assert.deepEqual(await readdir(destination), [], "Never overwrite an existing consumer installation");
  ownsDestination = true;
  temporary = await mkdtemp("/work/tmp/bw-sp-pack-");
  console.log(JSON.stringify({ created: [destination, temporary, "package installation", "Shell guest build processes"], borrowed: [preparedWaffle], retainedOnSuccess: destination }));
  await execute([process.execPath, "pm", "pack", "--destination", temporary, "--quiet"], root);
  const archive = (await readdir(temporary)).find(name => /^bun-wasm-.*\.tgz$/.test(name));
  assert.ok(archive, "Public Bun package archive");
  await cp(join(temporary, archive), join(destination, archive));
  const waffle = `git+https://github.com/ShaulLavo/waffle.git#${waffleCommit}`;
  await Bun.write(join(destination, "package.json"), JSON.stringify({ private: true, type: "module", dependencies: { "bun-wasm": `file:./${archive}`, "bash-web": `git+https://github.com/ShaulLavo/bash-web.git#${shellCommit}`, waffle, esbuild: "0.28.2", playwright: "1.64.1", typescript: "7.0.2", "@types/bun": "1.4.3" } }, null, 2));
  await execute([process.execPath, "install", "--ignore-scripts"], destination);
  const installedWaffle = join(destination, "node_modules/waffle");
  const shell = join(destination, "node_modules/bash-web");
  assert.equal(await peer(shell), waffle, "Reject mismatched public Shell before any fixture build");
  assert.equal(await peer(join(destination, "node_modules/bun-wasm")), waffle, "Reject mismatched public Bun before any fixture build");
  const expected = await Bun.file(join(installedWaffle, "package.json")).text();
  assert.equal(await Bun.file(join(preparedWaffle, "package.json")).text(), expected, "Borrowed built Waffle must be the exact installed package");
  // Builders must never write through package-cache symlinks or hardlinks.
  await detachPackage(installedWaffle);
  await detachPackage(shell);
  await cp(join(preparedWaffle, "dist"), join(installedWaffle, "dist"), { recursive: true });
  for (const name of ["network.wasm", "network.sha256", "network.input-hash"]) await cp(join(preparedWaffle, "browser/net", name), join(installedWaffle, "browser/net", name));
  await mkdir(join(shell, "node_modules"), { recursive: true });
  await symlink("../../waffle", join(shell, "node_modules/waffle"), "dir");
  const env = { ...process.env, CARGO_TARGET_DIR: join(destination, "cargo") };
  await execute([process.execPath, "scripts/build-worker.mjs"], shell, env);
  await execute([process.execPath, "scripts/build-shell-browser.mjs"], shell, env);
  await execute([process.execPath, "scripts/build-utilities.ts"], shell, env);
  prepared = true;
  console.log(`Prepared public package consumer at ${destination}. Caller owns removal after browser consumers finish.`);
} finally { clearTimeout(deadline); await cleanup(); }
