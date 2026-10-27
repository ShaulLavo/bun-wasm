import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import type { Browser, Page } from "playwright";
import type { ProductApi } from "../../tests/shell-product/protocol";
import { bundleProduct } from "./browser-shell-product-install";

declare global { var shellProduct: ProductApi; }
const root = resolve(import.meta.dir, "../..");
const installation = process.env.SHELL_PRODUCT_INSTALL;
const guest = process.env.STDIN_SCRIPT_GUEST;
assert.ok(installation && isAbsolute(installation), "SHELL_PRODUCT_INSTALL must name a prepared shell product installation");
assert.ok(guest && isAbsolute(guest), "STDIN_SCRIPT_GUEST must name the selected CLI guest");
const report = process.env.STDIN_SCRIPT_REPORT;
assert.ok(report && isAbsolute(report), "STDIN_SCRIPT_REPORT must name an evidence file");
let scratch: string | undefined;
let browser: Browser | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let page: Page | undefined;
let cleanupPromise: Promise<void> | undefined;
const results: { command: string; code: number | null; output: string }[] = [];
let released: unknown;
function cleanup() {
  return cleanupPromise ??= (async () => {
    try { released = await page?.evaluate(() => globalThis.shellProduct?.cleanup()); }
    finally {
      try { await browser?.close(); }
      finally {
        server?.stop(true);
        if (scratch) await rm(scratch, { recursive: true, force: true });
      }
    }
  })();
}
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => void cleanup().finally(() => process.exit(130)));
const deadline = setTimeout(() => void cleanup().finally(() => process.exit(1)), 180000);
async function command(text: string, expected: readonly string[], code = 0) {
  assert.ok(page);
  const result = await page.evaluate(text => globalThis.shellProduct.command(text, 30000), text);
  results.push({ command: text, ...result });
  console.log(JSON.stringify(results.at(-1)));
  assert.equal(result.code, code, `${text}\n${result.output}`);
  const lines = result.output.split(/\r?\n/);
  for (const line of expected) assert.ok(lines.includes(line), `Missing ${line}\n${result.output}`);
  return result;
}
try {
  scratch = await mkdtemp(join(tmpdir(), "bw-stdin-"));
  const output = join(scratch, "dist");
  const packages = await bundleProduct(root, installation, output);
  const bytes = await Bun.file(guest).bytes();
  const { shellCommit, wafflePeerCommit, waffleHostCommit, networkInputHash } = packages;
  console.log(JSON.stringify({ guest, guestBytes: bytes.length, guestSha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"), shellCommit, wafflePeerCommit, waffleHostCommit, networkInputHash }));
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const pathname = new URL(request.url).pathname;
    const headers = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp", "Cache-Control": "no-store" };
    if (pathname === "/bun-guest.wasm") return new Response(bytes, { headers: { ...headers, "Content-Type": "application/wasm" } });
    const path = resolve(output, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!path.startsWith(output + sep) || !await Bun.file(path).exists()) return new Response(null, { status: 404, headers });
    return new Response(Bun.file(path), { headers });
  } });
  const { chromium }: typeof import("playwright") = await import(pathToFileURL(join(installation, "node_modules/playwright/index.mjs")).href);
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.port}/`);
  await page.waitForFunction(() => Reflect.has(globalThis, "shellProduct"));
  await page.evaluate(() => globalThis.shellProduct.setup());
  await page.evaluate(() => globalThis.shellProduct.open({ id: "stdin-script", files: { "value.ts": "export const value = 42;" }, dependencies: {}, scripts: {}, selector: "", text: "", tool: "", buildOutputs: [] }, "http://127.0.0.1:1"));
  await command(`echo "console.log('Hello')" | bun run -`, ["Hello"]);
  await command(`printf '%s\\n' 'import { value } from "./value.ts"; const answer: number = value; console.log("TS:" + answer); console.log("ARGV:" + JSON.stringify(process.argv.slice(1))); console.log("MAIN:" + import.meta.main); console.log("FILE:" + import.meta.file);' | bun run - alpha --help`, ["TS:42", 'ARGV:["-","alpha","--help"]', "MAIN:true", "FILE:[stdin]"]);
  await command(`echo "console.log('After separator')" | bun run -- -`, ["After separator"]);
  await command(`printf '' | bun run -`, []);
  const invalid = await command(`echo "console.log('SHOULD_NOT_EXECUTE')" | bun run --unknown-stdin-flag`, [], 1);
  assert.ok(invalid.output.includes("unknown flag --unknown-stdin-flag"));
  assert.ok(!invalid.output.split(/\r?\n/).includes("SHOULD_NOT_EXECUTE"));
  const thrown = await command(`echo "throw new Error('STDIN_THROW')" | bun run -`, [], 1);
  assert.ok(thrown.output.includes("STDIN_THROW"));
  await command("echo PROMPT_USABLE", ["PROMPT_USABLE"]);
} finally {
  clearTimeout(deadline);
  await cleanup();
  await Bun.write(report, JSON.stringify({ results, cleanup: released, scratchRemoved: scratch ? !existsSync(scratch) : true }, null, 2));
  assert.deepEqual(released, { workers: 0, listeners: 0 });
  assert.ok(!scratch || !existsSync(scratch));
}
