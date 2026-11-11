// The stack sweep of browser-stack.mjs in genuine desktop Safari, over SafariDriver. Playwright
// WebKit is not Safari: Darwin gives Safari's workers 512 KiB of stack (docs/stack-limits.md).
// Run it on the Mac through the installed queue, from the repository root or a staged copy holding
// this script's bundle, web/serve.ts, tests/stack-depth.js and the two stack-overflow fixtures:
//   ROOT=<site> ENGINES=jsc STACK_KIB=240 JSC_PARSER_RESERVE=832 bun web/tests/browser-stack-safari.ts --measure --cold
// `--measure` and `--cold` mean what they mean in browser-stack.mjs. A cold attempt is a new
// SafariDriver session on a new document, so its wasm starts in JavaScriptCore's first tier.
// SAFARI_CLEANUP_FILE names the driver teardown receipt.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { withNativeDriver } from "../../scripts/goals-matrix/native.ts";
import { foreground, ObservationTimeout, ready, stopServer, terminal } from "../../scripts/goals-matrix/playground.ts";
import { createSafariTransport, type SafariTransport } from "../../scripts/goals-matrix/safari-transport.ts";
import { measureStackPaths, observeStackOutcome, stackEnvironmentPrefix, type GuestStackSettings } from "../../scripts/stack-measurement.ts";
import { effectiveParserReserve } from "../src/engine-stack-budget.ts";

interface Host { readonly endpoint: string; readonly url: string; readonly signal: AbortSignal }
interface Result { readonly code: number | null; readonly output: string }

const args = process.argv.slice(2);
const measure = args.includes("--measure");
const cold = args.includes("--cold");
const engines = (process.env.ENGINES ?? "quickjs,jsc,browser").split(",");
const site = resolve(process.env.ROOT ?? "web/dist");
const probe = readFileSync("tests/stack-depth.js", "utf8");
const fixtureNames = ["stack-overflow", "stack-overflow-console"];
// As in browser-stack.mjs: unset keys leave the executor's host policy in charge, as for a user.
const requested: GuestStackSettings = { budget: process.env.STACK_KIB ?? null, parserReserve: process.env.JSC_PARSER_RESERVE ?? null };
const settingsPrefix = stackEnvironmentPrefix(requested);
const observed = new Set<string>();
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function withPage<T>(host: Host, engine: string, use: (page: SafariTransport) => Promise<T>): Promise<T> {
  host.signal.throwIfAborted();
  const page = await createSafariTransport({ endpoint: host.endpoint, browser: "safari", timeoutMs: 200_000 });
  try {
    await page.navigate(`${host.url}?engine=${engine}&prompt=off&mode=memory&cold=${crypto.randomUUID()}`);
    await ready(page, engine, 120_000);
    return await use(page);
  } finally { await page.close(); }
}

function writeFile(page: SafariTransport, path: string, text: string): Promise<unknown> {
  return page.evaluate(`globalThis.playground.fs.writeFile(${JSON.stringify(path)}, ${JSON.stringify(text)})`);
}

/** The exit code, or null when the command outlived its deadline and its foreground was stopped. */
async function exitCode(page: SafariTransport, text: string, timeoutMs: number): Promise<number | null> {
  try {
    const result = await foreground(page, text, timeoutMs);
    if (result.error) throw new Error(`${text}: ${result.error}`);
    return result.code;
  } catch (error) {
    if (!(error instanceof ObservationTimeout)) throw error;
    await stopServer(page, 15_000);
    return null;
  }
}

/** One command's exit code and its own terminal lines: the prompt line before it and the prompt after it are excluded. */
async function run(page: SafariTransport, text: string, timeoutMs: number): Promise<Result> {
  const before = (await terminal(page)).split("\n").length;
  const code = await exitCode(page, text, timeoutMs);
  const lines = (await terminal(page)).split("\n");
  return { code, output: lines.slice(before, -1).join("\n") };
}

async function outcome(page: SafariTransport, mode: string, depth: number): Promise<string> {
  await writeFile(page, "/home/user/depth.js", probe);
  const result = await run(page, `${settingsPrefix}bun run depth.js ${mode} ${depth}`, 180_000);
  const observation = observeStackOutcome({ result, mode, depth, requested });
  if (observation.settings) observed.add(JSON.stringify(observation.settings));
  return observation.outcome;
}

async function fixtures(page: SafariTransport, label: string, names: readonly string[]): Promise<void> {
  for (const name of names) {
    const base = join("tests/fixtures", name);
    await writeFile(page, `/home/user/${name}.js`, readFileSync(join(base, "index.js"), "utf8"));
    const expected = readFileSync(join(base, "expected.txt"), "utf8").trim();
    const result = await run(page, `${settingsPrefix}bun run ${name}.js`, 60_000);
    if (result.code !== 0 || result.output.trim() !== expected) throw new Error(`${label} ${name}: exit ${result.code}\n${result.output}`);
    console.log(`ok ${label} ${name}`);
  }
}

function reportSettings(label: string, engine: string): void {
  const guests: GuestStackSettings[] = Array.from(observed, entry => JSON.parse(entry));
  observed.clear();
  const effective = engine === "jsc" ? guests.map(guest => effectiveParserReserve(guest.parserReserve ?? undefined)) : null;
  console.log(JSON.stringify({ host: label, settings: { requested, guests, effectiveParserReserve: effective } }));
}

/** The browser must fetch the JSC side this site holds, so a row names the bytes that ran. */
async function bindSide(page: SafariTransport): Promise<void> {
  const served = sha256(gunzipSync(readFileSync(join(site, "jsc-engine.wasm.gz"))));
  const fetched = await page.evaluate<string>(`(async () => {
    const response = await fetch("./jsc-engine.wasm.gz?bind=" + Date.now());
    if (!response.ok || !response.body) throw new Error("side fetch " + response.status);
    const bytes = await new Response(response.body.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
    return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
  })()`);
  assert.equal(fetched, served, "Safari fetched another JSC side");
  console.log(JSON.stringify({ jscSide: { served, fetched } }));
}

async function identify(page: SafariTransport, engine: string, label: string): Promise<void> {
  const agent = await page.evaluate<string>("navigator.userAgent");
  console.log(JSON.stringify({ host: label, capabilities: page.capabilities, agent, cold, measure }));
  if (engine === "jsc" && existsSync(join(site, "jsc-engine.wasm.gz"))) await bindSide(page);
}

async function measureEngine(engine: string, label: string, attempt: (mode: string, depth: number) => Promise<string>): Promise<void> {
  const failed = await measureStackPaths(attempt, label, row => console.log(JSON.stringify(row)));
  reportSettings(label, engine);
  if (failed) throw new Error(`failed stack measurement ${label} (see rows above)`);
}

// SafariDriver holds one session at a time, so a cold run never keeps a page open across attempts.
async function checkCold(host: Host, engine: string, label: string): Promise<void> {
  await withPage(host, engine, page => identify(page, engine, label));
  if (measure) await measureEngine(engine, label, (mode, depth) => withPage(host, engine, page => outcome(page, mode, depth)));
  for (const fixture of fixtureNames) await withPage(host, engine, page => fixtures(page, label, [fixture]));
}

async function checkEngine(host: Host, engine: string): Promise<void> {
  const label = `safari/${engine}`;
  if (cold) return checkCold(host, engine, label);
  await withPage(host, engine, async (page) => {
    await identify(page, engine, label);
    if (measure) await measureEngine(engine, label, (mode, depth) => outcome(page, mode, depth));
    await fixtures(page, label, fixtureNames);
  });
}

async function served<T>(use: (url: string) => Promise<T>): Promise<T> {
  const server = Bun.spawn(["bun", "web/serve.ts"], { env: { ...process.env, ROOT: site, HOST: "127.0.0.1", PORT: "0" }, stdout: "pipe", stderr: "inherit" });
  try {
    const reader = server.stdout.getReader();
    const first = await reader.read();
    reader.releaseLock();
    const url = /at (http:\/\/\S+)/.exec(new TextDecoder().decode(first.value))?.[1];
    if (!url) throw new Error("The playground server did not publish a URL");
    return await use(url);
  } finally { server.kill("SIGTERM"); await server.exited; }
}

await served(url => withNativeDriver(async (endpoint, signal) => {
  for (const engine of engines) await checkEngine({ endpoint, url, signal }, engine);
}, { desktopSafari: true, cleanupFile: process.env.SAFARI_CLEANUP_FILE }));
