// Stack overflow in browser workers: the stack-overflow fixtures on every engine, in Chromium and
// WebKit. `--measure` also runs tests/stack-depth.js: every recursion path at full depth must throw
// rather than trap, and the main paths get a capacity search. `--cold` measures in a fresh browser
// context per attempt, so the wasm runs in its engine's first tier (docs/stack-limits.md).
//   node tests/browser-stack.mjs [--measure [--cold]] [chromium] [webkit]
//   ENGINES=quickjs node tests/browser-stack.mjs --measure webkit
import { readFileSync } from 'node:fs';
import { firstVisit } from './first-visit.mjs';
import { measureStackPaths, stackOutcome } from '../../scripts/stack-measurement.ts';
import { playwright, ready, run, session, writeFile } from './playground.mjs';

const s = session('bun-wasm-web-stack-');
const engines = (process.env.ENGINES ?? 'quickjs,jsc,browser').split(',');
const args = process.argv.slice(2);
const measure = args.includes('--measure');
const cold = args.includes('--cold');
const browsers = args.filter((name) => !name.startsWith('--'));
if (!browsers.length) browsers.push('chromium', 'webkit');
const probe = readFileSync(new URL('../../tests/stack-depth.js', import.meta.url), 'utf8');

async function fixtures(page, label) {
  for (const name of ['stack-overflow', 'stack-overflow-console']) {
    const base = new URL(`../../tests/fixtures/${name}/`, import.meta.url);
    await writeFile(page, `/home/user/${name}.js`, readFileSync(new URL('index.js', base), 'utf8'));
    const expected = readFileSync(new URL('expected.txt', base), 'utf8').trim();
    const result = await run(page, `bun run ${name}.js`);
    if (result.code !== 0 || result.output.trim() !== expected) {
      throw new Error(`${label} ${name}: exit ${result.code}\n${result.output}`);
    }
    console.log(`ok ${label} ${name}`);
  }
}

async function outcome(page, mode, n, nativeFirefox) {
  await writeFile(page, '/home/user/depth.js', probe);
  const result = await run(page, `bun run depth.js ${mode} ${n}`, 180000);
  return stackOutcome(result, mode, n, nativeFirefox);
}

async function openPage(browser, name, url, engine) {
  const context = await browser.newContext(name === 'webkit' ? playwright.devices['iPhone 13'] : {});
  const visit = await firstVisit(context, `${url}?engine=${engine}&prompt=off`);
  const page = await context.newPage();
  await page.goto(visit.url);
  await ready(page);
  return { page, close: async () => { await visit.close(); await context.close(); } };
}

async function checkEngine(browser, name, url, engine) {
  const label = `${name}/${engine}`;
  const opened = await openPage(browser, name, url, engine);
  try {
    if (measure) {
      const nativeFirefox = engine === 'browser' && name === 'firefox';
      const fresh = async (mode, n) => {
        const once = await openPage(browser, name, url, engine);
        try { return await outcome(once.page, mode, n, nativeFirefox); } finally { await once.close(); }
      };
      const failed = await measureStackPaths(
        cold ? fresh : (mode, n) => outcome(opened.page, mode, n, nativeFirefox),
        label, row => console.log(JSON.stringify(row)),
      );
      if (failed) throw new Error(`failed stack measurement ${label} (see rows above)`);
    }
    await fixtures(opened.page, label);
  } finally { await opened.close(); }
}

async function checkBrowser(name, url) {
  const browser = await s.launch(playwright[name]);
  try {
    for (const engine of engines) await checkEngine(browser, name, url, engine);
  } finally { await browser.close(); }
}

try {
  const url = await s.serve();
  for (const name of browsers) await checkBrowser(name, url);
} finally { await s.cleanup(); }
