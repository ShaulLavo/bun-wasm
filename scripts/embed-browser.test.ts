import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { gunzipSync } from "node:zlib";
import { chromium, webkit, type BrowserType } from "playwright";
import { buildBrowserEntries } from "./browser-build";
import { verifySite } from "./browser-guest-site";

// Runs the embed guide's example (tests/embed/main.ts) in a real browser against the real guest.
// The limit only catches a hang.
setDefaultTimeout(240_000);

const root = resolve(import.meta.dir, "..");
const browsers: Record<string, BrowserType> = { chromium, webkit };

/** CI passes the commit's browser-guest site; a local run uses dist/bun-browser.wasm. */
function guestBytes(): Uint8Array<ArrayBuffer> {
  const site = process.env.BUN_WASM_BROWSER_SITE;
  if (process.env.CI && !site) throw new Error("CI must provide the existing browser-guest site");
  if (!site) return new Uint8Array(readFileSync(process.env.BUN_WASM_TEST_BROWSER_WASM ?? join(root, "dist/bun-browser.wasm")));
  verifySite(resolve(site));
  return new Uint8Array(gunzipSync(readFileSync(join(site, "site/bun-browser.wasm.gz"))));
}

/** The page imports only package exports. Its workers are the files those exports re-export. */
async function bundle(out: string): Promise<void> {
  await buildBrowserEntries([
    join(root, "tests/embed/main.ts"),
    join(root, "web/src/worker.ts"),
    join(root, "web/src/notification-worker.ts"),
    join(root, "web/src/fs-worker.ts"),
  ], out, { runtimeWorker: true });
  await Bun.write(join(out, "index.html"), '<!doctype html><script type="module" src="/main.js"></script>');
}

function serve(out: string, guest: Uint8Array<ArrayBuffer>) {
  const headers = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp", "Cache-Control": "no-store" };
  const asset = { kind: "single", core: { url: "/guest.wasm", bytes: guest.length, sha256: new Bun.CryptoHasher("sha256").update(guest).digest("hex") } };
  return Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === "/guest.json") return Response.json(asset, { headers });
    if (pathname === "/guest.wasm") return new Response(guest, { headers: { ...headers, "Content-Type": "application/wasm" } });
    const path = resolve(out, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!path.startsWith(out + sep) || !await Bun.file(path).exists()) return new Response(null, { status: 404, headers });
    return new Response(Bun.file(path), { headers });
  } });
}

for (const name of (process.env.BUN_WASM_TEST_BROWSERS ?? "chromium,webkit").split(",")) {
  test(`${name}: the embed guide's runBun example runs real Bun commands in a page`, async () => {
    const type = browsers[name];
    if (!type) throw new Error(`Unsupported browser ${name}`);
    const scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "bun-wasm-embed-"));
    let server: ReturnType<typeof serve> | undefined;
    const browser = await type.launch({ headless: true });
    try {
      await bundle(scratch);
      server = serve(scratch, guestBytes());
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${server.port}/`);
      await page.waitForFunction(() => Reflect.get(globalThis, "embedResult"), undefined, { timeout: 200_000 });
      const result = await page.evaluate(() => Reflect.get(globalThis, "embedResult"));
      expect(result.ok, result.error).toBe(true);
      expect(result.example.exitCode).toBe(0);
      expect(result.example.stdout).toMatch(/^\d+\.\d+\.\d+\n$/);
      expect(result.typescript).toEqual({ exitCode: 3, stdout: "hello from TypeScript\n", stderr: "to stderr\n", stopped: false });
      expect(result.tests.exitCode, result.tests.stderr).toBe(0);
      expect(result.tests.stderr).toContain("1 pass");
      expect(result.tests.stderr).toContain("0 fail");
      expect(result.stdin).toEqual({ exitCode: 0, stdout: "piped input\n", stderr: "", stopped: false, chunks: "piped input\n" });
      expect(result.killed.stopped).toBe(true);
      expect(result.killed.stdout).toBe("running\n");
      expect(result.killed.exitCode).toBe(137);
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
      server?.stop(true);
      rmSync(scratch, { recursive: true, force: true });
    }
  });
}
