import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const scratch: string[] = [];
afterEach(async () => { await Promise.all(scratch.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

// Each build removes its previous output first, so a bad setting must fail before that. The builds
// write into a disposable BUN_WASM_APP_OUT, so a regression can never erase the checkout's dist.
test.each(["web", "sandbox"])("the %s build refuses an invalid Brotli quality before touching its previous output", async app => {
  const out = await mkdtemp(join(process.env.BUN_WASM_TEST_TMP ?? tmpdir(), `bun-wasm-${app}-quality-`));
  scratch.push(out);
  const marker = join(out, "previous-build.txt");
  await writeFile(marker, "previous build");
  const child = Bun.spawn([process.execPath, join(root, app, "build.ts")], {
    cwd: join(root, app), env: { ...process.env, BUN_WASM_BROTLI_QUALITY: "12", BUN_WASM_APP_OUT: out }, stdout: "pipe", stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 30_000);
  try {
    expect(await child.exited).not.toBe(0);
    expect(await new Response(child.stderr).text()).toContain("BUN_WASM_BROTLI_QUALITY must be an integer from 0 to 11");
  } finally { clearTimeout(timeout); }
  expect(existsSync(marker)).toBe(true);
}, 40_000);

test.each(["web", "sandbox"])("the %s build writes into BUN_WASM_APP_OUT instead of the checkout's dist", async app => {
  const out = await mkdtemp(join(process.env.BUN_WASM_TEST_TMP ?? tmpdir(), `bun-wasm-${app}-out-`));
  scratch.push(out);
  const dist = join(root, app, "dist");
  const before = existsSync(dist);
  // No guests: the build warns and still writes the page, which is all this checks.
  const missing = join(out, "no-guests");
  const env = { ...process.env, BUN_WASM_APP_OUT: join(out, "dist"), BUN_WASM: join(missing, "bun.wasm"), JSC_WASM: join(missing, "bun-jsc.wasm"),
    BUN_BROWSER_WASM: join(missing, "bun-browser.wasm"), BUN_TOOLS_WASM: join(missing, "bun-tools.wasm"), BASH_WEB_GUESTS_DIR: missing, BASH_WEB_GUESTS: "" };
  const child = Bun.spawn([process.execPath, join(root, app, "build.ts")], { cwd: join(root, app), env, stdout: "ignore", stderr: "pipe" });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 110_000);
  try {
    expect(await child.exited, await new Response(child.stderr).text()).toBe(0);
  } finally { clearTimeout(timeout); }
  expect(existsSync(join(out, "dist/index.html"))).toBe(true);
  expect(existsSync(join(out, "dist/engine-builds.json"))).toBe(true);
  expect(existsSync(dist)).toBe(before);
}, 120_000);
