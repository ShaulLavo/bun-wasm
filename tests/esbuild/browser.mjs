import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registry } from '../../scripts/app-matrix/registry.mjs';
import { playwright, ready, run, session, writeFile } from '../../web/tests/playground.mjs';

const task = session('bun-wasm-esbuild-browser-');
let mirror;
const checks = (process.env.ESBUILD_CHECKS ?? 'check.cjs,sync.cjs,watch.cjs').split(',');
const failures = [];
async function command(page, text) {
  const result = await run(page, text, 120000);
  assert.equal(result.code, 0, `${text} exited ${result.code}\n${result.output}`);
  return result.output;
}
async function check(browserName, engine, url) {
  const browser = await task.launch(playwright[browserName]);
  const failuresBefore = failures.length;
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
    await page.goto(`${url}?engine=${engine}&prompt=off`);
    assert.match(await ready(page), /ready/);
    await writeFile(page, '/home/user/package.json', JSON.stringify({ dependencies: { esbuild: '0.25.12' } }));
    await writeFile(page, '/home/user/bunfig.toml', `[install]\nregistry = ${JSON.stringify(mirror.base)}\n`);
    for (const check of checks) await writeFile(page, `/home/user/${check}`, readFileSync(new URL(check, import.meta.url), 'utf8'));
    await command(page, 'bun install');
    for (const check of checks) {
      try { console.log(`${browserName}/${engine} ${check}`, await command(page, `bun run ${check}`)); }
      catch (error) { failures.push(error); console.error(`${browserName}/${engine}`, error.message); }
    }
    if (!checks.includes('check.cjs')) return;
    assert.match(await command(page, 'bun run node_modules/esbuild/bin/esbuild --version'), /0\.25\.12/);
    await command(page, 'bun run node_modules/esbuild/bin/esbuild entry.ts --bundle --outfile=cli.js');
    assert.match(await command(page, 'cat cli.js'), /43/);
    assert.deepEqual(external, []);
    if (failures.length === failuresBefore) console.log(`PASS ${browserName}/${engine} official esbuild API and CLI`);
  } finally { await browser.close(); }
}
try {
  mirror = await registry({ directory: process.env.MATRIX_CACHE ?? '/work/cache/bun-wasm-app-matrix', record: false });
  const url = await task.serve();
  const browsers = process.argv.slice(2).length ? process.argv.slice(2) : ['chromium', 'webkit'];
  for (const browser of browsers) {
    for (const engine of (process.env.ENGINES ?? 'quickjs,jsc,browser').split(',')) await check(browser, engine, url);
  }
  assert.equal(failures.length, 0, failures.map(error => error.message).join('\n'));
  assert.deepEqual(mirror.misses, []);
  assert.deepEqual(mirror.errors, []);
} finally { await mirror?.close(); await task.cleanup(); }
