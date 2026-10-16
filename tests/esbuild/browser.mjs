import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registry } from '../../scripts/app-matrix/registry.mjs';
import { playwright, ready, run, session, writeFile } from '../../web/tests/playground.mjs';

const task = session('bun-wasm-esbuild-browser-');
let mirror;
async function command(page, text) {
  const result = await run(page, text, 120000);
  assert.equal(result.code, 0, `${text} exited ${result.code}\n${result.output}`);
  return result.output;
}
async function check(browserName, engine, url) {
  const browser = await task.launch(playwright[browserName]);
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const external = [];
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      const host = url.protocol === 'blob:' ? new URL(url.pathname).hostname : url.hostname;
      if (['127.0.0.1', 'localhost'].includes(host)) return route.continue();
      external.push(route.request().url());
      return route.abort();
    });
    await page.goto(`${url}?engine=${engine}`);
    assert.match(await ready(page), /ready/);
    await writeFile(page, '/home/user/package.json', JSON.stringify({ dependencies: { esbuild: '0.25.12' } }));
    await writeFile(page, '/home/user/bunfig.toml', `[install]\nregistry = ${JSON.stringify(mirror.base)}\n`);
    await writeFile(page, '/home/user/check.cjs', readFileSync(new URL('check.cjs', import.meta.url), 'utf8'));
    await command(page, 'bun install');
    assert.match(await command(page, 'bun run check.cjs'), /esbuild API passed/);
    assert.match(await command(page, 'bun run node_modules/esbuild/bin/esbuild --version'), /0\.25\.12/);
    await command(page, 'bun run node_modules/esbuild/bin/esbuild entry.ts --bundle --outfile=cli.js');
    assert.match(await command(page, 'cat cli.js'), /43/);
    assert.deepEqual(external, []);
    console.log(`PASS ${browserName}/${engine} official esbuild API and CLI`);
  } finally { await browser.close(); }
}
try {
  mirror = await registry({ directory: process.env.MATRIX_CACHE ?? '/work/cache/bun-wasm-app-matrix', record: false });
  const url = await task.serve();
  const browsers = process.argv.slice(2).length ? process.argv.slice(2) : ['chromium', 'webkit'];
  for (const browser of browsers) {
    for (const engine of (process.env.ENGINES ?? 'quickjs,jsc,browser').split(',')) await check(browser, engine, url);
  }
  assert.deepEqual(mirror.misses, []);
  assert.deepEqual(mirror.errors, []);
} finally { await mirror?.close(); await task.cleanup(); }
