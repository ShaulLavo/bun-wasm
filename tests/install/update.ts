import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createRegistry } from "./registry.mjs";

const root = resolve(import.meta.dirname, "../..");
const scratch = mkdtempSync("/work/tmp/bun-wasm-install-update-");
const children = new Set<ReturnType<typeof spawn>>();
let registry: Awaited<ReturnType<typeof createRegistry>>;
let cleaned = false;
async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  for (const child of children) child.kill("SIGKILL");
  await registry?.close();
  rmSync(scratch, { recursive: true, force: true });
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => void cleanup().then(() => process.exit(130)));
process.on("exit", () => { for (const child of children) child.kill("SIGKILL"); rmSync(scratch, { recursive: true, force: true }); });
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
try {
  registry = await createRegistry();
  const manifest = join(scratch, "package.json");
  writeFileSync(manifest, JSON.stringify({ dependencies: { "rehoist-parent": "2.0.0" } }));
  await run("install");
  assert.equal(existsSync(join(scratch, "node_modules/rehoist-child")), true);
  writeFileSync(manifest, JSON.stringify({ dependencies: { "rehoist-parent": "1.0.0" } }));
  await run("update");
  assert.equal(JSON.parse(readFileSync(join(scratch, "node_modules/rehoist-parent/package.json"), "utf8")).version, "1.0.0");
  assert.equal(existsSync(join(scratch, "node_modules/rehoist-child")), false, "bun update retained an obsolete transitive dependency");
  console.log("update prunes obsolete transitive dependencies");
} finally { await cleanup(); }
