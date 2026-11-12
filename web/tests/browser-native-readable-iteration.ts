import assert from "node:assert/strict";
import { playwright, session } from "./playground.mjs";

declare const nativeReadableIterationResult: { done: boolean; error: string | null; checks: string[] };
const task = session("bun-wasm-native-iteration-");
let server: ReturnType<typeof Bun.serve> | undefined;
const deadline = setTimeout(() => {
  const forced = setTimeout(() => process.exit(124), 5_000);
  server?.stop(true);
  void task.cleanup().finally(() => { clearTimeout(forced); process.exit(124); });
}, 75_000);

try {
  const build = await Bun.build({ entrypoints: [new URL("./native-readable-iteration-page.ts", import.meta.url).pathname], target: "browser" });
  assert.equal(build.success, true, String(build.logs));
  const artifact = build.outputs[0];
  assert.ok(artifact);
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    if (new URL(request.url).pathname === "/probe.js") return new Response(artifact, { headers: { "content-type": "text/javascript" } });
    return new Response('<!doctype html><script type="module" src="/probe.js"></script>', { headers: { "content-type": "text/html" } });
  } });
  for (const name of ["chromium", "webkit"] as const) {
    const browser = await task.launch(playwright[name]);
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(String(error)));
    await page.goto(server.url.href);
    await page.waitForFunction(() => typeof nativeReadableIterationResult !== "undefined" && nativeReadableIterationResult.done, undefined, { timeout: 15_000 });
    const result = await page.evaluate(() => nativeReadableIterationResult);
    assert.equal(result.error, null, JSON.stringify(result));
    assert.deepEqual(errors, []);
    assert.equal(result.checks.length, 3);
    console.log(`${name} ${browser.version()}: ${result.checks.join(", ")}`);
    await browser.close();
  }
} finally {
  server?.stop(true);
  try { await task.cleanup(); } finally { clearTimeout(deadline); }
}
