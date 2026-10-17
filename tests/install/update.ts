import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createRegistry, packageFixture } from "./registry.mjs";

const root = resolve(import.meta.dirname, "../..");
const scratch = mkdtempSync("/work/tmp/bun-wasm-install-update-");
const children = new Set<ReturnType<typeof spawn>>();
let registry: Awaited<ReturnType<typeof createRegistry>>;
let cleaned = false;
async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  const exits = Array.from(children, child => new Promise<void>(resolve => { child.once("close", () => resolve()); }));
  for (const child of children) child.kill("SIGKILL");
  await Promise.all(exits);
  await registry?.close();
  rmSync(scratch, { recursive: true, force: true });
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => void cleanup().then(() => process.exit(130)));
async function run(...args: string[]) {
  const browser = process.env.INSTALL_ENGINE === "browser";
  const options = ["--wasm", resolve(root, process.env.BUN_WASM || "dist/bun.wasm"), "--dir", `${scratch}::/`,
    "--env", "PWD=/", "--env", "HOME=/", "--env", `NPM_CONFIG_REGISTRY=${registry.base}`, "--env", "BUN_INSTALL_CACHE_DIR=/cache", "--"];
  const executable = browser ? process.execPath : process.env.BUN_WASM_LAUNCHER || "/work/tmp/bun-wasm-installer-target/release/bun-wasm";
  const argv = browser ? ["--no-warnings", join(root, "web/scripts/node-host.mjs"), "--net"].concat(options, args) : options.concat(args);
  const child = spawn(executable, argv, { stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  let output = "";
  child.stdout?.on("data", bytes => { output += bytes; });
  child.stderr?.on("data", bytes => { output += bytes; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 60000);
  try {
    const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    assert.equal(code, 0, `bun ${args.join(" ")}\n${output}`);
  } finally { clearTimeout(timer); children.delete(child); }
}
async function hoistedMemberUpdate(shared: boolean, names: readonly string[]) {
  rmSync(join(scratch, "bun.lock"), { force: true });
  rmSync(join(scratch, "node_modules"), { recursive: true, force: true });
  rmSync(join(scratch, "packages"), { recursive: true, force: true });
  const manifest = join(scratch, "package.json");
  const dependencies = shared ? { versioned: "1.0.0" } : { "is-number": "7.0.0" };
  writeFileSync(manifest, JSON.stringify({ workspaces: ["packages/*"], dependencies }));
  mkdirSync(join(scratch, "packages/member"), { recursive: true });
  const member = join(scratch, "packages/member/package.json");
  writeFileSync(member, JSON.stringify({ name: "member", version: "1.0.0", dependencies: { versioned: "1.0.0" } }));
  await run("install");
  if (shared) writeFileSync(manifest, JSON.stringify({ workspaces: ["packages/*"], dependencies: { versioned: "^1.0.0" } }));
  writeFileSync(member, JSON.stringify({ name: "member", version: "1.0.0", dependencies: { versioned: "^1.0.0" } }));
  await run("update", ...names, "--cwd", "/packages/member");
  const nested = join(scratch, "packages/member/node_modules/versioned/package.json");
  const resolved = existsSync(nested) ? nested : join(scratch, "node_modules/versioned/package.json");
  assert.equal(JSON.parse(readFileSync(resolved, "utf8")).version, "1.1.0", "member update retained a hoisted resolution pin");
  if (shared) assert.equal(JSON.parse(readFileSync(join(scratch, "node_modules/versioned/package.json"), "utf8")).version, "1.0.0", "member update advanced a shared root pin");
  console.log("member update refreshes a hoisted edge and preserves root ownership", shared ? "shared" : "member-only", names.length ? "named" : "all");
}

try {
  registry = await createRegistry([packageFixture("versioned", "2.1.0")]);
  const manifest = join(scratch, "package.json");
  writeFileSync(manifest, JSON.stringify({ dependencies: { "rehoist-parent": "2.0.0" } }));
  await run("install");
  assert.equal(existsSync(join(scratch, "node_modules/rehoist-child")), true);
  writeFileSync(manifest, JSON.stringify({ dependencies: { "rehoist-parent": "1.0.0" } }));
  await run("update");
  assert.equal(JSON.parse(readFileSync(join(scratch, "node_modules/rehoist-parent/package.json"), "utf8")).version, "1.0.0");
  assert.equal(existsSync(join(scratch, "node_modules/rehoist-child")), false, "bun update retained an obsolete transitive dependency");
  console.log("update prunes obsolete transitive dependencies");
  for (const names of [["versioned"], []]) {
  writeFileSync(manifest, JSON.stringify({ workspaces: ["packages/*"], dependencies: { versioned: "2.0.0" } }));
  mkdirSync(join(scratch, "packages/member"), { recursive: true });
  const member = join(scratch, "packages/member/package.json");
  writeFileSync(member, JSON.stringify({ name: "member", version: "1.0.0", dependencies: { versioned: "1.0.0" } }));
  await run("install");
  writeFileSync(member, JSON.stringify({ name: "member", version: "1.0.0", dependencies: { versioned: "^1.0.0" } }));
  writeFileSync(manifest, JSON.stringify({ workspaces: ["packages/*"], dependencies: { versioned: "^2.0.0" } }));
  await run("update", ...names, "--cwd", "/packages/member");
  const rootVersion = JSON.parse(readFileSync(join(scratch, "node_modules/versioned/package.json"), "utf8")).version;
  const memberVersion = JSON.parse(readFileSync(join(scratch, "packages/member/node_modules/versioned/package.json"), "utf8")).version;
  assert.equal(rootVersion, "2.0.0");
  assert.equal(memberVersion, "1.1.0", "selected workspace update retained a nested lock pin");
  console.log("selected workspace update refreshes its nested resolution and preserves root pins", names.length ? "named" : "all");
  rmSync(join(scratch, "bun.lock"));
  rmSync(join(scratch, "node_modules"), { recursive: true });
  rmSync(join(scratch, "packages"), { recursive: true });
  }
  for (const shared of [false, true]) {
    for (const names of [["versioned"], []]) await hoistedMemberUpdate(shared, names);
  }
} finally { await cleanup(); }
