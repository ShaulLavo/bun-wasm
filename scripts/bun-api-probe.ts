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
export type EngineResult = { engine: string; bootMs: number; status: string; helloMs: number[]; cases: CaseResult[] };

// Imported by its unit test, it reads no arguments.
const { values } = parseArgs({
  args: import.meta.main ? process.argv.slice(2) : [],
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
    // Bun.serve in the playground announces its preview URL in the terminal.
    if (line.startsWith("[preview] ")) continue;
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

/**
 * A case runs in /home/user/probe/<name>, holding its fixture directory or `files` (written through
 * the page, not the shell). `exit` is the command's expected exit code (0 unless the fixture's
 * expected_exit says otherwise).
 */
type ProbeCase = { name: string; directory?: string; files?: Record<string, string>; command: string; exit?: number; expected: (output: string) => CheckResult[] };

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
    name: "pg-terminal-redirect",
    command: "echo typed > typed.txt && cat typed.txt",
    expected: output => [{ name: "terminal echo > file, cat", ...verdictFor(/^typed$/m.test(output), output) }],
  },
  {
    name: "pg-shell-commands",
    command: `bun -e 'import { $ } from "bun"; await $\`mkdir -p dir && touch dir/x.txt\`; const listed = (await $\`ls dir | tr a-z A-Z\`.text()).trim(); await $\`rm -rf dir\`; console.log("ok shell: " + listed + " " + (await Bun.file("dir/x.txt").exists()))'`,
    expected: output => [{ name: "$ mkdir/touch/ls/tr/rm", ...verdictFor(/ok shell: X\.TXT false/.test(output), output) }],
  },
  {
    name: "pg-shell-redirects",
    files: { "redirects.ts": `import { $ } from "bun";
const text = (await $\`cat < \${new Response("from response")}\`.text()).trim();
const buffer = Buffer.alloc(5);
await $\`echo hello > \${buffer}\`;
await $\`echo to-file > redirected.txt\`;
console.log("ok redirects: " + text + " " + buffer.toString() + " " + (await Bun.file("redirected.txt").text()).trim());
` },
    command: "bun redirects.ts",
    expected: output => [{ name: "$ Response input, Buffer and file output", ...verdictFor(/ok redirects: from response hello to-file/.test(output), output) }],
  },
];

/** Features that are not supported yet (docs/bun-api-probe.md); they leave the fixtures until they work. */
const GAP_CASES: ProbeCase[] = [
  {
    name: "gap-build-plugins",
    files: {
      "entry.ts": `import c from "virtual:config";\nconsole.log(c.mode);\n`,
      "build.ts": `const result = await Bun.build({
  entrypoints: ["./entry.ts"],
  plugins: [{ name: "virtual", setup(build) {
    build.onResolve({ filter: /^virtual:/ }, args => ({ path: args.path, namespace: "virtual" }));
    build.onLoad({ filter: /.*/, namespace: "virtual" }, () => ({ contents: "export default { mode: 'plugin' }", loader: "js" }));
  } }],
});
console.log("ok plugin: " + (await result.outputs[0].text()).includes("plugin"));
`,
    },
    command: "bun build.ts",
    expected: output => [{ name: "Bun.build plugins", ...verdictFor(/ok plugin: true/.test(output), output) }],
  },
  {
    name: "gap-small-apis",
    command: `bun -e 'const t = (n, f) => { try { console.log("ok " + n + ": " + f()); } catch (e) { console.log("FAIL " + n + ": " + e.message); } }; t("Bun.markdown.render", () => Bun.markdown.render("# hi", { heading: (c) => "H:" + c })); t("Bun.color", () => Bun.color("red", "hex"));'`,
    expected: output => [
      { name: "Bun.markdown.render", ...verdictFor(/ok Bun\.markdown\.render: H:hi/.test(output), output) },
      { name: "Bun.color", ...verdictFor(/ok Bun\.color: #ff0000/.test(output), output) },
    ],
  },
];

/** Probes that need the npm registry: only the playground reaches it. */
const NETWORK_CASES: ProbeCase[] = [
  {
    name: "net-bun-add-react",
    files: {
      "package.json": `{ "name": "react-probe" }\n`,
      "app.tsx": `import { renderToString } from "react-dom/server";
const App = ({ name }: { name: string }) => <h1>hello {name}</h1>;
console.log("ok render: " + renderToString(<App name="bun" />));
`,
    },
    command: "bun add react@19 react-dom@19 && bun app.tsx",
    expected: output => [{ name: "bun add + react ssr", ...verdictFor(/ok render: <h1>hello <!-- -->bun<\/h1>/.test(output), output) }],
  },
  {
    name: "net-bun-init",
    files: { ".keep": "" },
    command: "bun init -y && bun run index.ts && bun pm ls",
    expected: output => [{ name: "bun init -y + run", ...verdictFor(/Hello via Bun!/.test(output), output) }],
  },
  {
    name: "net-bunx",
    command: "bunx cowsay@1.6.0 moo",
    expected: output => [{ name: "bunx cowsay", ...verdictFor(/< moo >/.test(output), output) }],
  },
  {
    name: "net-fetch",
    command: `bun -e 'const r = await fetch("https://registry.npmjs.org/bun"); console.log("ok fetch: " + r.status)'`,
    expected: output => [{ name: "fetch https", ...verdictFor(/ok fetch: 200/.test(output), output) }],
  },
];

function verdictFor(ok: boolean, output: string): { verdict: Verdict; detail?: string } {
  return ok ? { verdict: "pass" } : { verdict: "fail", detail: output.split("\n").slice(-6).join(" | ") };
}

async function writeCase(page: Page, probe: ProbeCase): Promise<void> {
  const base = `/home/user/probe/${probe.name}`;
  const fixtureFiles = probe.directory ? filesOf(probe.directory).map(file => [relative(probe.directory!, file), readFileSync(file, "utf8")] as const) : [];
  const listed = Object.entries(probe.files ?? { ".keep": "" });
  for (const [path, text] of fixtureFiles.filter(([path]) => !CONTROL_FILES.has(path)).concat(listed)) await writeFile(page, `${base}/${path}`, text);
}

/** Fills `result` as cases finish, so a failure part-way keeps what already ran. */
async function runEngine(browser: Browser, url: string, result: EngineResult, cases: ProbeCase[]): Promise<void> {
  const engine = result.engine;
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const started = Date.now();
    await navigateTestPage(page, `${url}${url.includes("?") ? "&" : "?"}engine=${engine}&prompt=off`);
    // An engine that never boots is a result, not a reason to stop probing the others.
    const status = await ready(page, timeout).catch(async (error: Error) => `not ready: ${(await page.textContent("#status").catch(() => null)) ?? error.message}`);
    Object.assign(result, { bootMs: Date.now() - started, status });
    process.stderr.write(`${engine}: ${status} after ${result.bootMs} ms\n`);
    if (!/ready/.test(status) || status.startsWith("not ready")) return;
    await writeFile(page, "/home/user/probe/hello.ts", `console.log("hello world");\n`);
    for (let attempt = 0; attempt < 3; attempt++) result.helloMs.push(Math.round((await run(page, "bun /home/user/probe/hello.ts", timeout)).ms));
    for (const probe of cases) {
      await writeCase(page, probe);
      const ran = await run(page, `cd /home/user/probe/${probe.name} && ${probe.command}`, timeout);
      const wanted = probe.exit ?? 0;
      const exit: CheckResult = ran.code === wanted ? { name: "exit code", verdict: "pass" } : { name: "exit code", verdict: "fail", detail: `expected ${wanted}, got ${ran.code ?? "timeout"}` };
      result.cases.push({ name: probe.name, code: ran.code, ms: Math.round(ran.ms), checks: probe.expected(ran.output).concat([exit]), output: ran.output });
      process.stderr.write(`${engine} ${probe.name}: exit ${ran.code} in ${Math.round(ran.ms)} ms\n`);
      if (ran.code === null) await run(page, "cd /home/user", 10000);
    }
  } finally {
    await context.close();
  }
}

/** A Markdown table cell: a literal `|` would end the cell, and a line break the row. Backslashes
 * are escaped first, so a value's own `\|` cannot turn into `\\|` and end the cell. */
export function cell(text: string): string {
  return text.replaceAll("\\", "\\\\").replaceAll("|", "\\|").replace(/\r\n|\r|\n/g, " ");
}

export function table(results: EngineResult[]): string {
  const engines = results.map(result => result.engine);
  const rows = new Map<string, Map<string, CheckResult>>();
  const cells = results.flatMap(result => result.cases.flatMap(probe => probe.checks.map(check => ({ engine: result.engine, key: `${cell(probe.name.replace(/^bun-probe-/, ""))} | ${cell(check.name)}`, check }))));
  for (const { engine, key, check } of cells) {
    if (!rows.has(key)) rows.set(key, new Map());
    rows.get(key)!.set(engine, check);
  }
  const mark = (check?: CheckResult) => check === undefined ? "–" : check.verdict === "pass" ? "pass" : check.verdict === "differs" ? "**differs**" : "**FAIL**";
  const lines = [
    `| Area | Check | ${engines.map(cell).join(" | ")} |`,
    `| --- | --- | ${engines.map(() => "---").join(" | ")} |`,
    ...Array.from(rows, ([key, byEngine]) => `| ${key} | ${engines.map(engine => mark(byEngine.get(engine))).join(" | ")} |`),
    "",
    `| Engine | Boot to ready (ms) | bun hello.ts (ms, 3 runs) | Passing |`,
    `| --- | ---: | --- | ---: |`,
    ...results.map(result => {
      const checks = result.cases.flatMap(probe => probe.checks);
      const count = `${checks.filter(check => check.verdict === "pass").length}/${checks.length}`;
      // An engine that stopped early shows why next to what it finished.
      const stopped = result.status.startsWith("failed") || result.status.startsWith("not ready");
      const passing = !checks.length ? result.status : stopped ? `${count} (${result.status})` : count;
      return `| ${cell(result.engine)} | ${result.bootMs} | ${result.helloMs.join(", ")} | ${cell(passing)} |`;
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
      const result: EngineResult = { engine, bootMs: 0, status: "not started", helloMs: [], cases: [] };
      results.push(result);
      await runEngine(browser, url, result, cases).catch((error: Error) => {
        result.status = `failed after ${result.cases.length} cases: ${error.message.split("\n")[0]}`;
      });
      if (values.out) writeFileSync(values.out, JSON.stringify({ url, browser: values.browser, results }, null, 2));
    }
    console.log(table(results));
  } finally {
    await task.cleanup();
  }
}

if (import.meta.main) await main();
