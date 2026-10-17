import assert from "node:assert/strict";
import { createRegistry } from "../../tests/install/registry.mjs";
import { playwright, ready, run, session, writeFile } from "./playground.mjs";

const task = session("bun-wasm-installer-links-");
let registry: Awaited<ReturnType<typeof createRegistry>>;
try {
  registry = await createRegistry();
  const url = await task.serve();
  const browser = await task.launch(playwright.chromium);
  const context = await browser.newContext();
  const page = await context.newPage();
  const external: string[] = [];
  await context.route("**/*", route => {
    const url = new URL(route.request().url());
    const host = url.protocol === "blob:" ? new URL(url.pathname).hostname : url.hostname;
    if (host === "127.0.0.1" || host === "localhost") return route.continue();
    external.push(route.request().url());
    return route.abort();
  });
  await page.goto(`${url}?engine=browser`);
  assert.match(await ready(page), /ready/);
  await writeFile(page, "/home/user/package.json", '{"name":"browser-bin-fixture","dependencies":{"is-odd":"3.0.1"}}\n');
  await writeFile(page, "/home/user/bunfig.toml", `[install]\nregistry = ${JSON.stringify(registry.base)}\n`);
  const installed = await run(page, "bun install");
  assert.equal(installed.code, 0, installed.output);
  await writeFile(page, "/home/user/node_modules/is-odd/package.json", JSON.stringify({
    name: "is-odd", version: "3.0.1", main: "index.js", dependencies: { "is-number": "^7.0.0" }, bin: { "is-odd": "index.js" },
  }));
  await writeFile(page, "/home/user/check-bin-fixture.ts", 'import fs from "node:fs"; console.log("fixture-bin:", JSON.parse(fs.readFileSync("node_modules/is-odd/package.json", "utf8")).bin["is-odd"]);');
  const checked = await run(page, "bun run check-bin-fixture.ts");
  assert.equal(checked.code, 0, checked.output);
  assert.match(checked.output, /fixture-bin: index\.js/);
  const withBinary = await run(page, "bun install");
  console.log(JSON.stringify({ engine: "browser", withoutBinary: installed, withBinary, external }));
  assert.deepEqual(external, [], "probe attempted an external request");
  assert.equal(withBinary.code, 0, `browser package binaries require filesystem links\n${withBinary.output}`);
} finally {
  await registry?.close();
  await task.cleanup();
}
