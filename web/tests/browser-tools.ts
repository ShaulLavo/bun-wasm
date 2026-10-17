import assert from "node:assert/strict";
import { join } from "node:path";
import { playwright, session, ready, writeFile, run } from "./playground.mjs";

const s = session("bun-wasm-tools-");
const deadline = setTimeout(() => { void s.cleanup().finally(() => process.exit(1)); }, 300000);
try {
  const url = await s.serve();
  for (const name of process.argv.slice(2).length ? process.argv.slice(2) : ["chromium", "webkit"]) {
    for (const engine of ["quickjs", "jsc", "browser"]) {
      const context = await s.launch({ launch: () => playwright[name].launchPersistentContext(join(s.scratch, `${name}-${engine}`)) });
      const page = await context.newPage();
      const downloads: string[] = [];
      page.on("request", request => { if (request.url().includes("bun-tools.wasm")) downloads.push(request.url()); });
      await page.goto(`${url}?engine=${engine}`);
      assert.match(await ready(page), /ready/);
      await writeFile(page, "/home/user/tool-source.ts", "export const answer: number = 42;\n");
      assert.equal((await run(page, "bun run tool-source.ts")).code, 0);
      assert.equal((await run(page, "bun build tool-source.ts --outdir out")).code, 0);
      assert.deepEqual(downloads, [], "ordinary page, run and build must not fetch tools");
      const first = await run(page, "bun lint tool-source.ts");
      assert.equal(first.code, 0, first.output);
      assert.equal(downloads.length, 1, "first lint fetches tools once");
      assert.equal((await run(page, "bun fmt --check tool-source.ts")).code, 0);
      assert.equal(downloads.length, 1, "fmt reuses compiled tools");
      await page.waitForFunction(async () => {
        const cache = await caches.open("bunwasm-engines");
        const key = new URL("bun-tools.wasm", location.href).href;
        const response = await cache.match(key);
        const build = Reflect.get(globalThis, "__bunwasmBuilds")["bun-tools.wasm"];
        return response?.headers.get("x-bunwasm-build") === build;
      });
      const cold = await page.evaluate(() => performance.getEntriesByType("resource").filter(entry => entry.name.includes("bun-tools.wasm")).map(entry => ({ url: entry.name, duration: entry.duration, transferSize: Reflect.get(entry, "transferSize") })));
      await page.reload();
      await ready(page);
      await writeFile(page, "/home/user/tool-source.ts", "export const answer: number = 42;\n");
      assert.equal((await run(page, "bun lint tool-source.ts")).code, 0);
      console.log(JSON.stringify({ browser: name, engine, firstLintMs: first.ms, downloads, resources: cold }));
      assert.equal(downloads.length, 1, "reload compiles tools from persistent cache");
      await context.close();
    }
  }
} finally { clearTimeout(deadline); await s.cleanup(); }
