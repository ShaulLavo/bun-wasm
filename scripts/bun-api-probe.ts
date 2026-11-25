// Runs the Bun API probe fixtures (tests/fixtures/bun-probe-*) in the playground on each engine,
// the way a person types them, and prints a pass table. docs/bun-api-probe.md describes the probe.
//
//   bun scripts/bun-api-probe.ts [--url URL] [--engines quickjs,jsc,browser[,spidermonkey]]
//     [--browser chromium|webkit] [--cases bun-probe-utils,...] [--out results.json] [--network]
//
// Without --url it serves the local web/dist (build it with `bun web/build.ts`). --network adds the
// cases that reach the npm registry (bun add, bunx). Each check is compared with the line native
// Bun printed in the fixture's expected.txt.
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { chromium, webkit, type Browser, type Page } from "playwright";
import { ready, run, session, writeFile } from "../web/tests/playground.mjs";
import { navigateTestPage } from "../web/tests/navigate-test-page.ts";

const root = resolve(import.meta.dir, "..");
const fixtures = join(root, "tests/fixtures");

type Verdict = "pass" | "fail" | "differs";
type CheckResult = { name: string; verdict: Verdict; detail?: string };
type CaseResult = { name: string; code: number | null; ms: number; checks: CheckResult[]; output: string };
type EngineResult = { engine: string; bootMs: number; status: string; helloMs: number[]; cases: CaseResult[] };

const { values } = parseArgs({
  options: {
    url: { type: "string" },
    // SpiderMonkey is staged only when the site was built with SPIDERMONKEY_WASM; name it to include it.
    engines: { type: "string", default: "quickjs,jsc,browser" },
    browser: { type: "string", default: "chromium" },
    cases: { type: "string" },
    out: { type: "string" },
    network: { type: "boolean", default: false },
    timeout: { type: "string", default: "180000" },
  },
});
const timeout = Number(values.timeout);

/** Splits `ok name: value` / `FAIL name: message` lines into records, continuing multi-line values. */
export function records(text: string): Map<string, { ok: boolean; body: string }> {
  const out = new Map<string, { ok: boolean; body: string }>();
  let current: { name: string; ok: boolean; lines: string[] } | undefined;
  const flush = () => { if (current) out.set(current.name, { ok: current.ok, body: current.lines.join("\n").trimEnd() }); };
  for (const line of text.split("\n")) {
    const match = /^(ok|FAIL) ([^:]+?)(?::(.*))?$/.exec(line);
    if (match) {
      flush();
      current = { name: match[2]!, ok: match[1] === "ok", lines: [match[3]?.trim() ?? ""] };
      continue;
    }
    current?.lines.push(line);
  }
  flush();
  return out;
}

/**
 * bun test reports `(pass) describe > name` lines on stderr (native expectations keep them in
 * expected_stderr.txt), then a summary: ` 14 pass`, ` 2 snapshots, 32 expect() calls`,
 * `Ran 16 tests across 1 file.` Every summary line is a check keyed by its words, so any count change differs.
 */
function testReport(text: string): Map<string, { ok: boolean; body: string }> {
  const out = new Map<string, { ok: boolean; body: string }>();
  for (const match of text.matchAll(/^\((pass|fail|skip|todo)\) (.+?)(?: \[[\d.]+m?s\])?$/gm)) out.set(match[2]!, { ok: match[1] !== "fail", body: match[1]! });
  for (const match of text.matchAll(/^(?: \d+ .+|snapshots: .+|Ran \d+ tests? across \d+ files?\.)(?= \[|$)/gm)) {
    const line = match[0].trim();
    out.set(`summary ${line.replace(/\d+/g, "#")}`, { ok: true, body: line });
  }
  return out;
}

function compare(expected: Map<string, { ok: boolean; body: string }>, actual: Map<string, { ok: boolean; body: string }>): CheckResult[] {
  return Array.from(expected, ([name, want]) => {
    const got = actual.get(name);
    if (!got) return { name, verdict: "fail", detail: "no output" };
    if (!got.ok) return { name, verdict: "fail", detail: got.body };
    if (got.body !== want.body) return { name, verdict: "differs", detail: `expected ${JSON.stringify(want.body)}, got ${JSON.stringify(got.body)}` };
    return { name, verdict: "pass" };
  });
}

function filesOf(directory: string): string[] {
  return readdirSync(directory).flatMap(entry => {
    const path = join(directory, entry);
    return statSync(path).isDirectory() ? filesOf(path) : [path];
  });
}

/** `exit` is the command's expected exit code (0 unless the fixture's expected_exit says otherwise). */
type ProbeCase = { name: string; directory?: string; command: string; exit?: number; expected: (output: string) => CheckResult[] };

const CONTROL_FILES = new Set(["expected.txt", "expected_stderr.txt", "expected_exit", "cmd", "args", "host", "manual", "show"]);

function fixtureCase(name: string): ProbeCase {
  const directory = join(fixtures, name);
  const entry = readdirSync(directory).find(file => /^index\.(ts|tsx|js|mjs)$/.test(file));
  const cmd = existsIn(directory, "cmd") ? readFileSync(join(directory, "cmd"), "utf8").trim().split("\n").join(" ") : `run ${entry}`;
  const stdin = existsIn(directory, "stdin") ? " < stdin" : "";
  const isTest = cmd.startsWith("test");
  const expectedText = readFileSync(join(directory, isTest ? "expected_stderr.txt" : "expected.txt"), "utf8");
  const expected = isTest ? testReport(expectedText) : records(expectedText);
  return {
    name,
    directory,
    command: `bun ${cmd}${stdin}`,
    exit: existsIn(directory, "expected_exit") ? Number(readFileSync(join(directory, "expected_exit"), "utf8").trim()) : 0,
    expected: output => compare(expected, isTest ? testReport(output) : records(output)),
  };
}

function existsIn(directory: string, file: string): boolean {
  try { return statSync(join(directory, file)).isFile(); } catch { return false; }
}

/** Probes that need the playground's programs (coreutils on PATH), not available to the native launcher. */
const PLAYGROUND_CASES: ProbeCase[] = [
  {
    name: "pg-shell-commands",
    command: `mkdir -p /home/user/probe/shell && cd /home/user/probe/shell && bun -e 'import { $ } from "bun"; await $\`mkdir -p dir && touch dir/x.txt\`; const listed = (await $\`ls dir | tr a-z A-Z\`.text()).trim(); await $\`rm -rf dir\`; console.log("ok shell: " + listed + " " + (await Bun.file("dir/x.txt").exists()))'`,
    expected: output => [{ name: "$ mkdir/touch/ls/tr/rm", ...verdictFor(/ok shell: X\.TXT false/.test(output), output) }],
  },
  {
    name: "pg-shell-redirects",
    command: `cd /home/user/probe && bun -e 'import { $ } from "bun"; const text = (await $\`cat < \${new Response("from response")}\`.text()).trim(); const buffer = Buffer.alloc(5); await $\`echo hello > \${buffer}\`; await $\`echo to-file > redirected.txt\`; console.log("ok redirects: " + text + " " + buffer.toString() + " " + (await Bun.file("redirected.txt").text()).trim())'`,
    expected: output => [{ name: "$ Response input, Buffer and file output", ...verdictFor(/ok redirects: from response hello to-file/.test(output), output) }],
  },
];

/** Features that are not supported yet (docs/bun-api-probe.md); they leave the fixtures until they work. */
const GAP_CASES: ProbeCase[] = [
  {
    name: "gap-mock-module",
    command: `mkdir -p /home/user/probe/mockmod && cd /home/user/probe/mockmod && echo 'export const value = () => "real";' > dep.ts && printf '%s\\n' 'import { test, expect, mock } from "bun:test";' 'test("mock.module", async () => { mock.module("./dep.ts", () => ({ value: () => "mocked" })); expect((await import("./dep.ts")).value()).toBe("mocked"); });' > mock.test.ts && bun test`,
    expected: output => [{ name: "mock.module()", ...verdictFor(/1 pass/.test(output) && !/1 fail/.test(output), output) }],
  },
  {
    name: "gap-build-plugins",
    command: `mkdir -p /home/user/probe/plugin && cd /home/user/probe/plugin && echo 'import c from "virtual:config"; console.log(c.mode);' > entry.ts && bun -e 'const r = await Bun.build({ entrypoints: ["./entry.ts"], plugins: [{ name: "v", setup(b) { b.onResolve({ filter: /^virtual:/ }, a => ({ path: a.path, namespace: "v" })); b.onLoad({ filter: /.*/, namespace: "v" }, () => ({ contents: "export default { mode: \\"plugin\\" }", loader: "js" })); } }] }); console.log("ok plugin: " + (await r.outputs[0].text()).includes("plugin"))'`,
    expected: output => [{ name: "Bun.build plugins", ...verdictFor(/ok plugin: true/.test(output), output) }],
  },
  {
    name: "gap-small-apis",
    command: `cd /home/user && bun -e 'const t = (n, f) => { try { console.log("ok " + n + ": " + f()); } catch (e) { console.log("FAIL " + n + ": " + e.message); } }; t("Bun.markdown", () => Bun.markdown.html("# hi")); t("Bun.CSRF", () => Bun.CSRF.verify(Bun.CSRF.generate("s"), { secret: "s" })); t("Bun.color", () => Bun.color("red", "hex"));'`,
    expected: output => [
      { name: "Bun.markdown.html", ...verdictFor(/ok Bun\.markdown: <h1>hi<\/h1>/.test(output), output) },
      { name: "Bun.CSRF", ...verdictFor(/ok Bun\.CSRF: true/.test(output), output) },
      { name: "Bun.color", ...verdictFor(/ok Bun\.color: #ff0000/.test(output), output) },
    ],
  },
];

/** Probes that need the npm registry: only the playground reaches it. */
const NETWORK_CASES: ProbeCase[] = [
  {
    name: "net-bun-add-react",
    command: `mkdir -p /home/user/probe/react && cd /home/user/probe/react && echo '{"name":"r"}' > package.json && bun add react@19 react-dom@19 && printf '%s\\n' 'import { renderToString } from "react-dom/server";' 'const App = ({ name }: { name: string }) => <h1>hello {name}</h1>;' 'console.log("ok render: " + renderToString(<App name="bun" />));' > app.tsx && bun app.tsx`,
    expected: output => [{ name: "bun add + react ssr", ...verdictFor(/ok render: <h1>hello <!-- -->bun<\/h1>/.test(output), output) }],
  },
  {
    name: "net-bun-init",
    command: `mkdir -p /home/user/probe/fresh && cd /home/user/probe/fresh && bun init -y && bun run index.ts && bun pm ls`,
    expected: output => [{ name: "bun init -y + run", ...verdictFor(/Hello via Bun!/.test(output), output) }],
  },
  {
    name: "net-bunx",
    command: "cd /home/user && bunx cowsay@1.6.0 moo",
    expected: output => [{ name: "bunx cowsay", ...verdictFor(/< moo >/.test(output), output) }],
  },
  {
    name: "net-fetch",
    command: `cd /home/user && bun -e 'const r = await fetch("https://registry.npmjs.org/bun"); console.log("ok fetch: " + r.status)'`,
    expected: output => [{ name: "fetch https", ...verdictFor(/ok fetch: 200/.test(output), output) }],
  },
];

function verdictFor(ok: boolean, output: string): { verdict: Verdict; detail?: string } {
  return ok ? { verdict: "pass" } : { verdict: "fail", detail: output.split("\n").slice(-6).join(" | ") };
}

async function writeCase(page: Page, probe: ProbeCase): Promise<void> {
  if (!probe.directory) return;
  for (const file of filesOf(probe.directory)) {
    const path = relative(probe.directory, file);
    if (CONTROL_FILES.has(path)) continue;
    await writeFile(page, `/home/user/probe/${probe.name}/${path}`, readFileSync(file, "utf8"));
  }
}

async function runEngine(browser: Browser, url: string, engine: string, cases: ProbeCase[]): Promise<EngineResult> {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const started = Date.now();
    await navigateTestPage(page, `${url}${url.includes("?") ? "&" : "?"}engine=${engine}&prompt=off`);
    // An engine that never boots is a result, not a reason to stop probing the others.
    const status = await ready(page, timeout).catch(async (error: Error) => `not ready: ${(await page.textContent("#status").catch(() => null)) ?? error.message}`);
    const bootMs = Date.now() - started;
    const result: EngineResult = { engine, bootMs, status, helloMs: [], cases: [] };
    process.stderr.write(`${engine}: ${status} after ${bootMs} ms\n`);
    if (!/ready/.test(status) || status.startsWith("not ready")) return result;
    await writeFile(page, "/home/user/probe/hello.ts", `console.log("hello world");\n`);
    for (let attempt = 0; attempt < 3; attempt++) result.helloMs.push(Math.round((await run(page, "bun /home/user/probe/hello.ts", timeout)).ms));
    for (const probe of cases) {
      await writeCase(page, probe);
      const cd = probe.directory ? `cd /home/user/probe/${probe.name} && ` : "";
      const ran = await run(page, `${cd}${probe.command}`, timeout);
      const wanted = probe.exit ?? 0;
      const exit: CheckResult = ran.code === wanted ? { name: "exit code", verdict: "pass" } : { name: "exit code", verdict: "fail", detail: `expected ${wanted}, got ${ran.code ?? "timeout"}` };
      result.cases.push({ name: probe.name, code: ran.code, ms: Math.round(ran.ms), checks: probe.expected(ran.output).concat([exit]), output: ran.output });
      process.stderr.write(`${engine} ${probe.name}: exit ${ran.code} in ${Math.round(ran.ms)} ms\n`);
      if (ran.code === null) await run(page, "cd /home/user", 10000);
    }
    return result;
  } finally {
    await context.close();
  }
}

function table(results: EngineResult[]): string {
  const engines = results.map(result => result.engine);
  const rows = new Map<string, Map<string, CheckResult>>();
  const cells = results.flatMap(result => result.cases.flatMap(probe => probe.checks.map(check => ({ engine: result.engine, key: `${probe.name.replace(/^bun-probe-/, "")} | ${check.name}`, check }))));
  for (const { engine, key, check } of cells) {
    if (!rows.has(key)) rows.set(key, new Map());
    rows.get(key)!.set(engine, check);
  }
  const mark = (check?: CheckResult) => check === undefined ? "–" : check.verdict === "pass" ? "pass" : check.verdict === "differs" ? "**differs**" : "**FAIL**";
  const lines = [
    `| Area | Check | ${engines.join(" | ")} |`,
    `| --- | --- | ${engines.map(() => "---").join(" | ")} |`,
    ...Array.from(rows, ([key, byEngine]) => `| ${key} | ${engines.map(engine => mark(byEngine.get(engine))).join(" | ")} |`),
    "",
    `| Engine | Boot to ready (ms) | bun hello.ts (ms, 3 runs) | Passing |`,
    `| --- | ---: | --- | ---: |`,
    ...results.map(result => {
      const checks = result.cases.flatMap(probe => probe.checks);
      const passing = checks.length ? `${checks.filter(check => check.verdict === "pass").length}/${checks.length}` : result.status;
      return `| ${result.engine} | ${result.bootMs} | ${result.helloMs.join(", ")} | ${passing} |`;
    }),
  ];
  const failures = results.flatMap(result => result.cases.flatMap(probe => probe.checks.filter(check => check.verdict !== "pass").map(check => `- ${result.engine} ${probe.name} ${check.name}: ${check.detail ?? ""}`.slice(0, 400))));
  return lines.concat(failures.length ? ["", "Failures:", ...failures] : []).join("\n");
}

async function main(): Promise<void> {
  const names = values.cases?.split(",") ?? readdirSync(fixtures).filter(name => name.startsWith("bun-probe-")).sort();
  const cases = names.map(fixtureCase).concat(values.cases ? [] : PLAYGROUND_CASES.concat(GAP_CASES), values.network ? NETWORK_CASES : []);
  const task = session("bun-wasm-api-probe-");
  try {
    if (!values.url) process.env.ROOT ??= join(root, "web/dist");
    const url = values.url ?? await task.serve();
    const browser = await task.launch(values.browser === "webkit" ? webkit : chromium);
    const results: EngineResult[] = [];
    // One engine failing must not lose the others: record it, save after each engine, print at the end.
    for (const engine of values.engines!.split(",")) {
      const result = await runEngine(browser, url, engine, cases)
        .catch((error: Error): EngineResult => ({ engine, bootMs: 0, status: `failed: ${error.message.split("\n")[0]}`, helloMs: [], cases: [] }));
      results.push(result);
      if (values.out) writeFileSync(values.out, JSON.stringify({ url, browser: values.browser, results }, null, 2));
    }
    console.log(table(results));
  } finally {
    await task.cleanup();
  }
}

if (import.meta.main) await main();
