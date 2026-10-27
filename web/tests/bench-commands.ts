// Command latency benchmark for the playground: wall time from submitting a command at the prompt
// to the next prompt, cold (the first command after the page is ready) and warm (repeats).
//
//   bun tests/bench-commands.ts                        # serve web/dist locally, Chromium
//   LATENCY_MS=70 bun tests/bench-commands.ts          # every response 70 ms late, like a remote host
//   bun tests/bench-commands.ts --url https://bun.sprockt.dev/playground/
//   bun tests/bench-commands.ts --browser firefox --runs 7 --output /work/tmp/bun-wasm-bench.json
//   bun tests/bench-commands.ts --network              # also install, add, update, remove and bunx
//
// Each round opens a fresh browser context, so its first command is a cold start with empty
// caches. After the warm repeats the page reloads: its first command is the returning-visitor
// start. Exit codes and output are checked so a broken build cannot look fast.
import assert from "node:assert/strict";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { chromium, firefox, webkit, type Browser, type Page } from "playwright";

interface Case { readonly command: string; readonly code: number; readonly output: RegExp }

const offline: Case[] = [
  { command: "bun", code: 0, output: /Usage: bun <command>/ },
  { command: "bun tun", code: 1, output: /tun/ },
  { command: "bun --version", code: 0, output: /^\d+\.\d+\.\d+/m },
  { command: "bun run index.ts", code: 0, output: /Hello, Bun!/ },
  { command: "bun index.ts", code: 0, output: /Hello, Bun!/ },
  { command: "bun -e 'console.log(1 + 1)'", code: 0, output: /^2$/m },
  { command: "bun test math.test.ts", code: 0, output: /\bpass\b/ },
  { command: "bun build math.ts --outfile out/math.js", code: 0, output: /Bundled|math\.js/ },
];
// Needs the npm registry: real downloads, so these numbers include the network.
const online: Case[] = [
  { command: "bun add is-number@7.0.0", code: 0, output: /is-number/ },
  { command: "bun install", code: 0, output: /./ },
  { command: "bun update", code: 0, output: /./ },
  { command: "bun remove is-number", code: 0, output: /./ },
  { command: "bun x cowsay@1.6.0 hi", code: 0, output: /hi/ },
];

const { values: options } = parseArgs({
  options: {
    url: { type: "string" },
    browser: { type: "string", default: "chromium" },
    runs: { type: "string", default: "3" },
    repeats: { type: "string", default: "3" },
    output: { type: "string" },
    network: { type: "boolean", default: false },
  },
});
const runs = Number(options.runs);
const repeats = Number(options.repeats);
assert.ok(runs > 0 && repeats > 0, "--runs and --repeats must be positive");
const engines = { chromium, firefox, webkit };
assert.ok(options.browser in engines, `--browser must be one of ${Object.keys(engines).join(", ")}`);
const cases = options.network ? offline.concat(online) : offline;

let server: ReturnType<typeof Bun.spawn> | undefined;
let browser: Browser | undefined;
let cleaning: Promise<void> | undefined;
function cleanup(): Promise<void> {
  return cleaning ??= (async () => {
    try { await browser?.close(); }
    finally {
      server?.kill();
      await server?.exited;
    }
  })();
}
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => void cleanup().finally(() => process.exit(130)));

async function startServer(): Promise<string> {
  // PORT=0 lets the server take a free port; its first line names the URL it got.
  const child = Bun.spawn(["bun", join(import.meta.dir, "../serve.ts")], {
    env: { ...process.env, PORT: "0" }, stdout: "pipe", stderr: "inherit",
  });
  server = child;
  const reader = child.stdout.getReader();
  const { value } = await reader.read();
  reader.releaseLock();
  const line = new TextDecoder().decode(value);
  const url = / at (http:\/\/\S+) /.exec(line)?.[1];
  assert.ok(url, `serve.ts did not start: ${line}`);
  return url;
}

async function openPlayground(url: string, page?: Page): Promise<{ page: Page; readyMs: number }> {
  assert.ok(browser);
  page ??= await (await browser.newContext()).newPage();
  const start = performance.now();
  await page.goto(url);
  await page.waitForFunction(() => "playground" in globalThis && document.querySelector<HTMLElement>("#status")?.dataset.kind === "ok", null, { timeout: 180_000 });
  return { page, readyMs: performance.now() - start };
}

/** Submits one command at the prompt; returns its wall time, exit code and terminal output. */
function submit(page: Page, command: string) {
  return page.evaluate(async command => {
    const { shell, term } = Reflect.get(globalThis, "playground");
    // xterm applies writes asynchronously: flush them before reading the buffer.
    const flushed = () => new Promise<void>(resolve => term.write("", resolve));
    await flushed();
    const buffer = term.buffer.active;
    const first = buffer.baseY + buffer.cursorY + 1;
    const start = performance.now();
    await shell.submit(command);
    const ms = performance.now() - start;
    await flushed();
    const lines: string[] = [];
    for (let y = first; y < buffer.length; y++) lines.push(buffer.getLine(y)?.translateToString(true) ?? "");
    return { ms, code: Reflect.get(shell, "lastExit") as number, output: lines.join("\n") };
  }, command);
}

const failures = new Map<string, string>();

/** The command's wall time. A wrong exit code or output is recorded, and the run fails at the end. */
async function measure(page: Page, item: Case): Promise<number> {
  const result = await submit(page, item.command);
  if (result.code !== item.code || !item.output.test(result.output)) failures.set(item.command, `exit ${result.code}\n${result.output}`);
  return result.ms;
}

const median = (values: number[]) => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)] ?? NaN;

interface Samples { ready: number[]; cold: number[]; reloaded: number[]; warm: Map<string, number[]> }

/** One round: a fresh context, its cold first command, the warm repeats, then a reload. */
async function round(url: string, samples: Samples): Promise<void> {
  const { page, readyMs } = await openPlayground(url);
  samples.ready.push(readyMs);
  samples.cold.push(await measure(page, offline[0]!));
  for (let repeat = 0; repeat < repeats; repeat++) {
    for (const item of cases) samples.warm.get(item.command)!.push(await measure(page, item));
  }
  await openPlayground(url, page);
  samples.reloaded.push(await measure(page, offline[0]!));
  await page.context().close();
}

try {
  const url = options.url ?? await startServer();
  browser = await engines[options.browser as keyof typeof engines].launch({ headless: true });
  const samples: Samples = { ready: [], cold: [], reloaded: [], warm: new Map(cases.map(item => [item.command, []])) };
  for (let run = 0; run < runs; run++) await round(url, samples);
  const command = offline[0]!.command;
  const rows = [
    { what: "page ready", median: median(samples.ready), samples: samples.ready },
    { what: `cold: ${command}`, median: median(samples.cold), samples: samples.cold },
    { what: `after reload: ${command}`, median: median(samples.reloaded), samples: samples.reloaded },
  ].concat(Array.from(samples.warm, ([command, values]) => ({ what: `warm: ${command}`, median: median(values), samples: values })));
  for (const row of rows) console.log(`${row.what.padEnd(48)} ${row.median.toFixed(0).padStart(7)} ms   [${row.samples.map(value => value.toFixed(0)).join(" ")}]`);
  const report = { url, browser: options.browser, latencyMs: Number(process.env.LATENCY_MS ?? 0), runs, repeats, date: new Date().toISOString(), rows };
  if (options.output) await Bun.write(options.output, JSON.stringify({ ...report, failures: Object.fromEntries(failures) }, null, 2) + "\n");
  for (const [command, detail] of failures) console.error(`\nFAILED ${command}: ${detail}`);
  process.exitCode = failures.size ? 1 : 0;
} finally {
  await cleanup();
}
