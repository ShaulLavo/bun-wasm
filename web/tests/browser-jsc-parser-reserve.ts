// The JSC parser reserve through the real executor (docs/stack-limits.md). In each browser, on the
// JSC pair the site serves: the host's own defaults, the rows of the executor contract, a
// fixed-budget differential between two values, and instances alive at once with different values.
//   ROOT=<site> bun tests/browser-jsc-parser-reserve.ts chromium firefox
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import type { Browser, Page } from "playwright";
import { chainCapacities, chainMaximum, guestStackSettings, stackOutcome, type GuestStackSettings } from "../../scripts/stack-measurement.ts";
import { jscStackBudgets } from "../src/engine-stack-budget.ts";
import { deeper, pageHost, type PageHost } from "./parser-reserve-ownership.ts";
import { playwright, ready, run, session, web, writeFile } from "./playground.mjs";

const task = session("bun-wasm-jsc-parser-reserve-");
const probe = readFileSync(new URL("../../tests/stack-depth.js", import.meta.url), "utf8");
const site = resolve(process.env.ROOT ?? join(web, "dist"));
const browsers = process.argv.slice(2).length ? process.argv.slice(2) : ["chromium", "firefox"];
const timer = setTimeout(() => { void task.cleanup().finally(() => process.exit(124)); }, 840_000);
const BUDGET = "BUN_WASM_STACK_KIB", RESERVE = "BUN_WASM_JSC_PARSER_RESERVE";
// One budget for every explicit comparison: the smallest any host passes.
const fixed = jscStackBudgets.other;
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

// Guest input: children of one guest, alive at once, each with its own value.
const instances = `const { spawn } = require("node:child_process");
function capacity(reserve) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["depth.js", "chainCapacity", process.argv[2]], { env: { ...process.env, ${RESERVE}: reserve } });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.on("close", (code) => resolve({ code, output: encodeURIComponent(output) }));
  });
}
Promise.all(process.argv.slice(3).map(capacity)).then((children) => console.log("instances", JSON.stringify(children)));
`;

type Environment = Record<string, string>;
interface Measured { readonly settings: GuestStackSettings; readonly capacities: Record<string, number> }

const prefix = (env: Environment) => Object.entries(env).map(([key, value]) => `${key}='${value}' `).join("");

function measured(output: string): Measured {
  const settings = guestStackSettings(output);
  assert.ok(settings, "the guest printed no settings");
  return { settings, capacities: chainCapacities(output) };
}

async function measure(page: Page, env: Environment): Promise<Measured> {
  const result = await run(page, `${prefix(env)}bun run depth.js chainCapacity ${chainMaximum}`, 180_000);
  assert.equal(stackOutcome(result, "chainCapacity", chainMaximum), "completed", `chain capacity with ${JSON.stringify(env)}: ${JSON.stringify(result)}`);
  const guest = measured(result.output);
  console.log(JSON.stringify({ requested: env, guest: guest.settings, capacities: guest.capacities }));
  return guest;
}

/** The served side must be the finalized side this check was given, and the browser must fetch those bytes. */
async function bindSide(page: Page): Promise<void> {
  const side = sha256(gunzipSync(readFileSync(join(site, "jsc-engine.wasm.gz"))));
  const builds: Record<string, string> = JSON.parse(readFileSync(join(site, "engine-builds.json"), "utf8"));
  assert.equal(builds["jsc-engine.wasm"], side, "engine-builds.json names another JSC side");
  const finalized = process.env.JSC_SIDE_SHA256;
  if (finalized !== undefined) assert.equal(side, finalized, "the site serves another finalized JSC side");
  const fetched: string = await page.evaluate(async () => {
    const response = await fetch(`./jsc-engine.wasm.gz?bind=${Date.now()}`);
    if (!response.ok || !response.body) throw new Error(`side fetch ${response.status}`);
    const bytes = await new Response(response.body.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
    return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
  });
  assert.equal(fetched, side, "the browser fetched another JSC side");
  console.log(JSON.stringify({ jscSide: { finalized: finalized ?? null, served: side, fetched } }));
}

async function executorContract(page: Page, host: PageHost): Promise<void> {
  const policy = await measure(page, {});
  assert.deepEqual(policy.settings, { budget: host.budget, parserReserve: host.reserve }, "neither key: the host's defaults");
  const budgetOnly = await measure(page, { [BUDGET]: fixed });
  assert.deepEqual(budgetOnly.settings, { budget: fixed, parserReserve: host.reserve }, "budget only: the reserve default is independent");
  // A reduced reserve is tried only at the small fixed budget. At a host's own larger budget only
  // its qualified value is known to be safe: 1024 at V8's 800 KiB runs V8 itself out of stack.
  const reserveOnly = await measure(page, { [RESERVE]: "2048" });
  assert.deepEqual(reserveOnly.settings, { budget: host.budget, parserReserve: "2048" }, "reserve only: the budget default is independent");
  const full = await measure(page, { [BUDGET]: fixed, [RESERVE]: "2048" });
  const half = await measure(page, { [BUDGET]: fixed, [RESERVE]: "1024" });
  assert.deepEqual(half.settings, { budget: fixed, parserReserve: "1024" }, "both keys: both explicit");
  deeper(full.capacities, half.capacities, "one budget, two values");
  const empty = await measure(page, { [BUDGET]: fixed, [RESERVE]: "" });
  assert.deepEqual(empty.settings, { budget: fixed, parserReserve: "" }, "an empty reserve passes through");
  assert.deepEqual(empty.capacities, full.capacities, "an empty reserve is the guest's default");
  const rejected = await measure(page, { [BUDGET]: fixed, [RESERVE]: "1024kb" });
  assert.deepEqual(rejected.capacities, full.capacities, "a rejected reserve is the guest's default");
  const explicit = await measure(page, { [BUDGET]: host.budget, [RESERVE]: host.reserve ?? "2048" });
  assert.deepEqual(policy.capacities, explicit.capacities, "the host policy behaves as its explicit pair");
  if (host.reserve === null) assert.deepEqual(reserveOnly.capacities, policy.capacities, "an explicit 2048 is the default");
  else deeper(reserveOnly.capacities, policy.capacities, "the host's qualified value");
  // An earlier instance's value leaves no trace in a later one.
  assert.deepEqual((await measure(page, { [BUDGET]: fixed, [RESERVE]: "2048" })).capacities, full.capacities, "a later instance at the first value");
}

async function concurrentInstances(page: Page): Promise<void> {
  await writeFile(page, "/home/user/instances.js", instances);
  const output = (await run(page, `${prefix({ [BUDGET]: fixed })}bun run instances.js ${chainMaximum} 1024 2048 1536`, 240_000)).output;
  const line = output.split("\n").find(entry => entry.startsWith("instances "));
  assert.ok(line, `no instances line: ${output}`);
  const children: { code: number; output: string }[] = JSON.parse(line.slice("instances ".length));
  const [half, full, middle] = children.map((child) => {
    const transcript = decodeURIComponent(child.output);
    assert.equal(stackOutcome({ code: child.code, output: transcript }, "chainCapacity", chainMaximum), "completed", transcript);
    return measured(transcript);
  });
  assert.ok(half && full && middle);
  assert.deepEqual([half.settings.parserReserve, full.settings.parserReserve, middle.settings.parserReserve], ["1024", "2048", "1536"]);
  deeper(full.capacities, middle.capacities, "concurrent instances at 2048 and 1536");
  deeper(middle.capacities, half.capacities, "concurrent instances at 1536 and 1024");
  assert.deepEqual(half.capacities, (await measure(page, { [BUDGET]: fixed, [RESERVE]: "1024" })).capacities, "a concurrent instance matches one running alone");
  console.log(JSON.stringify({ concurrent: { half, full, middle } }));
}

async function opened(browser: Browser, url: string, engine: string, check: (page: Page) => Promise<void>): Promise<void> {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(`${url}?engine=${engine}&prompt=off&mode=memory`);
    await ready(page, 120_000);
    await writeFile(page, "/home/user/depth.js", probe);
    await check(page);
  } finally { await context.close(); }
}

/** No other engine is ever handed the key, whatever the host's table holds. */
async function neverHanded(page: Page, engine: string): Promise<void> {
  const result = await run(page, "bun run depth.js plain 1", 120_000);
  assert.equal(stackOutcome(result, "plain", 1), "completed", JSON.stringify(result));
  assert.equal(guestStackSettings(result.output)?.parserReserve, null, `${engine} was handed the JSC parser reserve`);
}

async function checkBrowser(name: string, url: string): Promise<void> {
  assert.ok(name === "firefox" || name === "chromium" || name === "webkit");
  const builds: Record<string, string> = JSON.parse(readFileSync(join(site, "engine-builds.json"), "utf8"));
  const browser: Browser = await task.launch(playwright[name]);
  try {
    await opened(browser, url, "jsc", async (page) => {
      await bindSide(page);
      const host = await pageHost(page, name);
      console.log(JSON.stringify({ browser: name, version: browser.version(), host }));
      await executorContract(page, host);
      await concurrentInstances(page);
    });
    console.log(`PASS ${name}/jsc parser reserve through the executor`);
    for (const [engine, file] of [["quickjs", "bun.wasm"], ["browser", "bun-browser.wasm"]] as const) {
      if (!(file in builds)) continue;
      await opened(browser, url, engine, page => neverHanded(page, engine));
      console.log(`PASS ${name}/${engine} is never handed the parser reserve`);
    }
  } finally { await browser.close(); }
}

try {
  const url = await task.serve();
  for (const name of browsers) await checkBrowser(name, url);
} finally { clearTimeout(timer); await task.cleanup(); }
