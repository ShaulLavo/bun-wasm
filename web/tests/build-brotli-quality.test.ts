import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { appOutput } from "../../scripts/app-output";

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

test("app builds write to BUN_WASM_APP_OUT only when it names a directory", () => {
  const app = join(root, "web");
  expect(appOutput(app, {})).toBe(join(app, "dist"));
  for (const blank of ["", " ", "\t\n"]) expect(appOutput(app, { BUN_WASM_APP_OUT: blank })).toBe(join(app, "dist"));
  expect(appOutput(app, { BUN_WASM_APP_OUT: "/work/tmp/bun-wasm-app-out" })).toBe("/work/tmp/bun-wasm-app-out");
  expect(appOutput(app, { BUN_WASM_APP_OUT: " relative/out " })).toBe(resolve("relative/out"));
});

test.each(["web/build.ts", "sandbox/build.ts"])("%s takes its output directory from appOutput before removing anything", async path => {
  const source = await Bun.file(join(root, path)).text();
  const output = source.indexOf("const out = appOutput(here);");
  expect(output).toBeGreaterThan(0);
  expect(output).toBeLessThan(source.indexOf("rmSync(out"));
});

test("the site build pins BUN_WASM_APP_OUT empty, so an app .env file cannot redirect a deploy", async () => {
  const source = await Bun.file(join(root, "site/build.ts")).text();
  expect(source).toContain('process.env.BUN_WASM_APP_OUT = "";');
  expect(source.indexOf('process.env.BUN_WASM_APP_OUT = "";')).toBeLessThan(source.indexOf('await build("sandbox")'));
});
