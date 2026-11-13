// Stack overflow in browser workers: the stack-overflow fixtures on every engine, in Chromium and
// WebKit. `--measure` also runs tests/stack-depth.js: every recursion path at full depth must throw
// rather than trap, and the main paths get a capacity search. `--cold` measures in a fresh browser
// context per attempt, so the wasm runs in its engine's first tier (docs/stack-limits.md).
//   node tests/browser-stack.mjs [--measure [--cold]] [chromium] [webkit]
//   ENGINES=quickjs node tests/browser-stack.mjs --measure webkit
//   ENGINES=jsc STACK_KIB=260 JSC_PARSER_RESERVE=1024 node tests/browser-stack.mjs --measure --cold firefox
import { readFileSync } from 'node:fs';
import { firstVisit } from './first-visit.mjs';
import { measureStackPaths, observeStackOutcome, stackEnvironmentPrefix } from '../../scripts/stack-measurement.ts';
import { stackSelection, reportStackSelection, reportStackCompletion } from '../../scripts/stack-parts.ts';
import { effectiveParserReserve } from '../src/engine-stack-budget.ts';
import { playwright, ready, run, session, writeFile } from './playground.mjs';

const engines = (process.env.ENGINES ?? 'quickjs,jsc,browser').split(',');
const args = process.argv.slice(2);
const measure = args.includes('--measure');
const cold = args.includes('--cold');
const selection = stackSelection(process.env.STACK_SLICE, measure, cold);
const s = session('bun-wasm-web-stack-');
const browsers = args.filter((name) => !name.startsWith('--'));
if (!browsers.length) browsers.push('chromium', 'webkit');
const probe = readFileSync(new URL('../../tests/stack-depth.js', import.meta.url), 'utf8');

const fixtureNames = selection.fixtures;
async function fixtures(page, label, names = fixtureNames) {
  for (const name of names) {
    const base = new URL(`../../tests/fixtures/${name}/`, import.meta.url);
    await writeFile(page, `/home/user/${name}.js`, readFileSync(new URL('index.js', base), 'utf8'));
    const expected = readFileSync(new URL('expected.txt', base), 'utf8').trim();
    const result = await run(page, `${settingsPrefix}bun run ${name}.js`);
    if (result.code !== 0 || result.output.trim() !== expected) {
      throw new Error(`${label} ${name}: exit ${result.code}\n${result.output}`);
    }
    console.log(`ok ${label} ${name}`);
  }
}

// STACK_KIB and JSC_PARSER_RESERVE set the guest's BUN_WASM_STACK_KIB and BUN_WASM_JSC_PARSER_RESERVE
// for every measured run. Without them the executor's host policy applies, as for a user.
const requested = { budget: process.env.STACK_KIB ?? null, parserReserve: process.env.JSC_PARSER_RESERVE ?? null };
const settingsPrefix = stackEnvironmentPrefix(requested);
// Every distinct pair a measured guest reported: what the executor actually passed it.
const observed = new Set();

async function outcome(page, mode, n, nativeFirefox) {
  await writeFile(page, '/home/user/depth.js', probe);
  const result = await run(page, `${settingsPrefix}bun run depth.js ${mode} ${n}`, 180000);
  const observation = observeStackOutcome({ result, mode, depth: n, requested, nativeFirefox });
  if (observation.settings) observed.add(JSON.stringify(observation.settings));
  return observation.outcome;
}

function reportSettings(label, engine) {
  const guests = Array.from(observed, (entry) => JSON.parse(entry));
  observed.clear();
  const effective = engine === 'jsc' ? guests.map((guest) => effectiveParserReserve(guest.parserReserve ?? undefined)) : null;
  console.log(JSON.stringify({ host: label, settings: { requested, guests, effectiveParserReserve: effective } }));
}

async function openPage(browser, name, url, engine) {
  const context = await browser.newContext(name === 'webkit' ? playwright.devices['iPhone 13'] : {});
  const visit = await firstVisit(context, `${url}?engine=${engine}&prompt=off`);
  const page = await context.newPage();
  await page.goto(visit.url);
  await ready(page);
  return { page, close: async () => { await visit.close(); await context.close(); } };
}

function coldAttempt(browser, name, url, engine, nativeFirefox) {
  return async (mode, depth) => {
    const once = await openPage(browser, name, url, engine);
    try { return await outcome(once.page, mode, depth, nativeFirefox); } finally { await once.close(); }
  };
}

async function coldFixtures(browser, name, url, engine, label) {
  for (const fixture of fixtureNames) {
    const once = await openPage(browser, name, url, engine);
    try { await fixtures(once.page, label, [fixture]); } finally { await once.close(); }
  }
}

async function checkEngine(browser, name, url, engine) {
  const label = `${name}/${engine}`;
  reportStackSelection(label, selection, cold, requested);
  const opened = await openPage(browser, name, url, engine);
  try {
    if (measure) {
      const nativeFirefox = engine === 'browser' && name === 'firefox';
      const failed = await measureStackPaths(
        cold ? coldAttempt(browser, name, url, engine, nativeFirefox) : (mode, n) => outcome(opened.page, mode, n, nativeFirefox),
        label, row => console.log(JSON.stringify(row)), selection.modes,
      );
      reportSettings(label, engine);
      if (failed) throw new Error(`failed stack measurement ${label} (see rows above)`);
    }
    await (cold ? coldFixtures(browser, name, url, engine, label) : fixtures(opened.page, label));
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
reportStackCompletion(browsers, engines, selection);
