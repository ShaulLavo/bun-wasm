import { expect, test } from "bun:test";
import { cp, mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { browserBuildConfig, resolveRuntimePackage } from "./browser-build";

// A real Git installation is essential: file/workspace copies can hide Node's
// node_modules TypeScript restrictions, prepare/trust failures and missing files.
test("trusted commit-pinned Git package prepares Node exports without sibling source", async () => {
  const scratch = await mkdtemp(join(process.env.TMPDIR ?? (existsSync("/work/tmp") ? "/work/tmp" : tmpdir()), "bun-wasm-installed-package-"));
  const children = new Set<ReturnType<typeof Bun.spawn>>();
  async function run(command: string[], cwd: string, env: Record<string, string | undefined> = {}): Promise<string> {
    const child = Bun.spawn(command, { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe", timeout: 120_000 });
    children.add(child);
    try {
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      if (code !== 0) throw new Error(`${command.join(" ")} exited ${code}\n${stdout}\n${stderr}`);
      return stdout;
    } finally { children.delete(child); }
  }
  try {
    const repository = join(scratch, "runtime.git.source");
    await cp(resolve(import.meta.dir, "../runtime"), repository, {
      recursive: true,
      filter(source) { return !["node_modules", "dist", ".git"].some(part => source.split("/").includes(part)); },
    });
    expect(existsSync(join(repository, "dist"))).toBe(false);
    await run(["git", "init", "-q"], repository);
    await run(["git", "add", "."], repository);
    await run(["git", "-c", "user.name=Package fixture", "-c", "user.email=fixture@localhost", "commit", "-qm", "Source-only package fixture\n\nCo-Authored-By: Claude Code <noreply@anthropic.com>"], repository);
    const pin = (await run(["git", "rev-parse", "HEAD"], repository)).trim();
    expect(await run(["git", "ls-files", "dist"], repository)).toBe("");
    const consumer = join(scratch, "isolated-consumer");
    await mkdir(consumer);
    const dependency = `git+${pathToFileURL(repository).href}#${pin}`;
    await writeFile(join(consumer, "package.json"), JSON.stringify({ name: "installed-runtime-check", private: true, type: "module", dependencies: { "@bun-wasm/runtime": dependency }, trustedDependencies: ["@bun-wasm/runtime"] }));
    const cache = join(scratch, "clean.install.cache");
    await mkdir(cache);
    expect(await readdir(cache)).toEqual([]);
    await run([process.execPath, "install"], consumer, { BUN_INSTALL_CACHE_DIR: cache });
    const entry = join(consumer, "main.ts");
    await writeFile(entry, 'export { memoryViews } from "@bun-wasm/runtime/core/memory-views";');
    const installed = resolveRuntimePackage(entry);
    expect(installed.physical.startsWith(scratch + "/")).toBe(true);
    expect(installed.physical).not.toBe(repository);
    expect(existsSync(join(installed.path, "dist/core/index.js"))).toBe(true);
    expect(existsSync(join(scratch, "web"))).toBe(false);
    const check = `import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const metadata = JSON.parse(readFileSync("./node_modules/@bun-wasm/runtime/package.json", "utf8"));
for (const [key, conditions] of Object.entries(metadata.exports)) {
  const specifier = "@bun-wasm/runtime" + (key === "." ? "" : key.slice(1));
  if (!conditions.node) {
    await assert.rejects(import(specifier), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
    continue;
  }
  const resolved = import.meta.resolve(specifier);
  assert.ok(resolved.includes("/dist/") && resolved.endsWith(".js"), resolved);
  await import(specifier);
}
await assert.rejects(import("@bun-wasm/runtime/internal/proc/table"), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
const root = await import("@bun-wasm/runtime/core");
const memory = await import("@bun-wasm/runtime/core/memory-views");
assert.equal(root.memoryViews, memory.memoryViews, "per-module exports must preserve identity");
console.log("every Node export links; browser-only entries reject; module identity preserved");`;
    await writeFile(join(consumer, "check.mjs"), check);
    expect(await run(["node", "check.mjs"], consumer)).toContain("every Node export links");
    expect(await run([process.execPath, "-e", 'import { Wasi } from "@bun-wasm/runtime/core"; console.log(typeof Wasi)'], consumer)).toContain("function");
    const { outdir, ...config } = browserBuildConfig([entry], join(scratch, "browser-output"), { runtimeWorker: true });
    const browser = await Bun.build(config);
    expect(browser.success).toBe(true);
    expect(Object.keys(browser.metafile!.inputs).every(input => installed.relativeInput(input) !== undefined || resolve(input) === entry)).toBe(true);
    expect(await Bun.file(join(consumer, "bun.lock")).text()).toContain(pin);
  } finally {
    for (const child of children) child.kill();
    await Promise.all(Array.from(children, child => child.exited));
    await rm(scratch, { recursive: true, force: true });
    expect(existsSync(scratch)).toBe(false);
  }
}, 180_000);
