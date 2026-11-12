import { browserType } from "./browser-type.ts";
import assert from "node:assert/strict";
import { createRegistry, packageFixture, tarEntry } from "../../tests/install/registry.mjs";
import { ready, run, session, writeFile } from "./playground.mjs";

const task = session("bun-wasm-installer-links-");
let registry: Awaited<ReturnType<typeof createRegistry>> | undefined;
const failures: string[] = [];

async function check(browserName: string, engine: string, url: string) {
  const browser = await task.launch(browserType(browserName));
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
  async function command(text: string) {
    const result = await run(page, text);
    assert.equal(result.code, 0, `${text}\n${result.output}`);
    return result.output;
  }
  try {
    await page.goto(`${url}?engine=${engine}&prompt=off`);
    assert.match(await ready(page), /ready/);
    await writeFile(page, "/home/user/package.json", JSON.stringify({ name: "page-bin-fixture", scripts: { dev: 'fixture-tool "two words"', explicit: "./fixture-tool.ts", runtime: "bun fixture-tool" } }));
    await writeFile(page, "/home/user/bunfig.toml", `[install]\nregistry = ${JSON.stringify(registry!.base)}\n`);
    await command("bun add is-odd");
    await writeFile(page, "/home/user/check-links.ts", 'import fs from "node:fs"; for (const bin of ["cli", "fixture-tool"]) console.log("link", bin, fs.existsSync("node_modules/.bin/" + bin));');
    for (const install of ["bun add @fixture/cli", "bun install --frozen-lockfile"]) {
      const checkInstallerCase = async () => {
      const output = await command(install);
      const warnings = output.split("\n").filter(line => line.includes("bin link skipped:"));
      const links = await command("bun run check-links.ts");
      let skipped = 0;
      for (const bin of ["cli", "fixture-tool"]) {
        const linked = links.includes(`link ${bin} true`);
        const matching = warnings.filter(line => line.includes(`@fixture/cli (${bin})`) && line.includes("bin link skipped: this filesystem does not support symbolic links"));
        assert.equal(matching.length, linked ? 0 : 1, output);
        if (!linked) skipped++;
      }
      assert.equal(warnings.length, skipped, output);

      };
      await checkInstallerCase();
    }
    await writeFile(page, "/home/user/check-lock.ts", 'import fs from "node:fs"; console.log("lock:", fs.readFileSync("bun.lock", "utf8").includes("@fixture/cli@1.0.0"));');
    assert.match(await command("bun run check-lock.ts"), /lock: true/);
    await command("rm -r node_modules/.bin");
    for (const [text, args] of [
      ["bun run fixture-tool direct", "direct"],
      ["bun run dev tail", "two words|tail"],
      ["bunx --no-install @fixture/cli local", "local"],
      ["bun x --no-install @fixture/cli local-x", "local-x"],
    ] as const) {
      const output = await command(text);
      assert.ok(output.includes(`page-cli ${args}`), output);
      assert.ok(output.includes("/home/user/node_modules/@fixture/cli/cli.ts"), output);
    }
    await writeFile(page, "/home/user/fixture-tool.ts", '#!/usr/bin/env bun\nconsole.log("page-source");');
    for (const [index, target] of [42, "", "../escape.ts", "/escape.ts"].entries()) {
      await writeFile(page, `/home/user/node_modules/z-bad-${index}/package.json`, JSON.stringify({ name: `z-bad-${index}`, bin: { "fixture-tool": target } }));
    }
    const bare = await command("bun run dev");
    assert.match(bare, /page-cli two words/);
    assert.doesNotMatch(bare, /page-source|warn:|Package bin|Invalid package bin/);
    for (const text of ["bun run fixture-tool", "bun run explicit", "bun run runtime"]) assert.match(await command(text), /page-source/);
    await command("rm bun.lock");
    await writeFile(page, "/home/user/node_modules/.bin", "not a directory");
    const failed = await run(page, "bun install");
    assert.equal(failed.code, 1, failed.output);
    assert.doesNotMatch(failed.output, /bin link skipped:/);
    await writeFile(page, "/home/user/check-failure.ts", 'import fs from "node:fs"; console.log("lock absent:", !fs.existsSync("bun.lock"));');
    assert.match(await command("bun run check-failure.ts"), /lock absent: true/);
    assert.deepEqual(external, [], "test attempted an external request");
    console.log(`ok ${browserName}/${engine}: bin warnings, lock, bun run, script, bunx, fatal non-link error`);
  } finally {
    await browser.close();
  }
}

try {
  const cli = packageFixture("@fixture/cli", "1.0.0", { bin: { cli: "cli.ts", "fixture-tool": "cli.ts" } }, undefined, [
    tarEntry("package/cli.ts", 'console.log("page-cli", process.argv.slice(2).join("|")); console.log("entry", process.argv[1], import.meta.main, import.meta.dir);'),
  ]);
  registry = await createRegistry([cli]);
  const url = await task.serve();
  const browsers = process.argv.slice(2).length ? process.argv.slice(2) : ["chromium", "webkit"];
  const engines = (process.env.ENGINES ?? "browser,quickjs,jsc").split(",");
  for (const browser of browsers) {
    const checkInstallerCase = async () => {
    for (const engine of engines) {
      try { await check(browser, engine, url); }
      catch (error) { failures.push(`${browser}/${engine}`); console.error(`FAIL ${browser}/${engine}`, error); }
    }

    };
    await checkInstallerCase();
  }
  console.log(`${browsers.length * engines.length - failures.length} passed, ${failures.length} failed`);
} finally {
  await registry?.close();
  await task.cleanup();
}
process.exitCode = failures.length ? 1 : 0;
