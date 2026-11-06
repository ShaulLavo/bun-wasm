// Worker module loading without a service-worker controller, through the built playground's Bun
// launcher (worker URL ./__bunwasm/worker.js, as the playground picks once its scope registers).
//
// Each guest process runs the same acyclic bootstrap: it prints `startup` and the executing
// worker's own service-worker capability (`unavailable` when the worker does not expose one, never
// read as null), then dynamically imports a graph of import cycles and prints its result, which
// must equal Node's for the same files.
//
//   bun web/tests/browser-module-records.ts [chromium] [webkit]
//   MODULE_RECORDS_ROOT=<built web dir>   serve another build (default web/dist)
//   MODULE_RECORDS_EXPECT=old             that build is the old loader: it must fail on the
//                                          graph after startup and the probe, in the uncontrolled
//                                          context (the controlled one is not checked)
//
// Contexts: `uncontrolled` removes the registration before the first command, so every guest
// worker (the second process runs on the pool's spare) starts outside any service worker;
// `controlled` keeps it and must show positive control of the executing worker.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright";
import { browserType } from "./browser-type.ts";
import { ready, run, session, web, writeFile } from "./playground.mjs";

const root = process.env.MODULE_RECORDS_ROOT ?? join(web, "dist");
const expectOld = process.env.MODULE_RECORDS_EXPECT === "old";

const files: Record<string, string> = {
  "boot.mjs": `console.log("startup", typeof Bun);
const scope = globalThis.WorkerGlobalScope?.prototype;
const workerNavigator = scope && Object.getOwnPropertyDescriptor(scope, "navigator")?.get?.call(globalThis);
const container = workerNavigator && "serviceWorker" in workerNavigator ? workerNavigator.serviceWorker : undefined;
console.log("controller", container == null ? "unavailable" : container.controller === null ? "null" : container.controller.scriptURL);
const graph = await import("./graph/main.mjs");
console.log("graph", graph.result);
`,
  "graph/setup.mjs": `globalThis.orderEvents = []; globalThis.tlaEvents = [];
let open; globalThis.gate = new Promise(resolve => { open = resolve; }); globalThis.openGate = open;`,
  "graph/main.mjs": `import "./setup.mjs";
import { order } from "./order/a.mjs";
import { even, odd, evenCalls, countEven, fromOdd } from "./cycle/even.mjs";
import * as self from "./main.mjs";
import kit, * as kitNamespace from "./kit/index.mjs";
import { metaA, metaB } from "./meta/a.mjs";
import anonymous from "./names/fn.mjs";
import Klass from "./names/cls.mjs";
export const marker = "main";
const attempt = f => { try { return String(f()); } catch (error) { return error.constructor.name; } };
countEven();
const tdz = await import("./tdz/a.mjs").then(() => "complete", error => error.constructor.name);
await import("./tla/a.mjs");
const oddAgain = await import("./cycle/odd.mjs");
const evenAgain = await import("./cycle/even.mjs");
export const result = [
  "order=" + order(), "hoisted=" + fromOdd + "," + even(10) + "," + odd(7), "live=" + evenCalls,
  "self=" + typeof self.marker + "," + (self.marker === marker), "kit=" + kit("x") + "," + (kitNamespace.kitNamespace.resolvePath === kit) + "," + Object.keys(kitNamespace).join(":"),
  "meta=" + metaA + "," + metaB, "names=" + anonymous.name + "," + Klass.name, "this=" + typeof this,
  "tdz=" + tdz, "tla=" + globalThis.tlaEvents.join(":"), "dynamic=" + (oddAgain.odd === odd) + "," + (evenAgain.even === even),
  "namespace=" + Object.isFrozen(self) + "," + JSON.stringify(Object.getOwnPropertyDescriptor(self, "marker")) + "," + attempt(() => Object.keys(evenAgain).join(":")),
].join(" ");
`,
  "graph/order/a.mjs": `import "./b.mjs"; import "./c.mjs"; globalThis.orderEvents.push("a"); export const order = () => globalThis.orderEvents.join(":");`,
  "graph/order/b.mjs": `import "./a.mjs"; globalThis.orderEvents.push("b");`,
  "graph/order/c.mjs": `globalThis.orderEvents.push("c");`,
  "graph/cycle/even.mjs": `import { odd, fromOdd } from "./odd.mjs";
export { odd, fromOdd };
export let evenCalls = 0;
export function even(n) { return n === 0 ? true : odd(n - 1); }
export function countEven() { evenCalls++; }`,
  "graph/cycle/odd.mjs": `import { even } from "./even.mjs";
export function odd(n) { return n === 0 ? false : even(n - 1); }
export const fromOdd = "even(2)=" + even(2);`,
  "graph/kit/index.mjs": `export * from "./utils.mjs";
export { resolvePath as default } from "./mlly.mjs";
import * as mlly from "./mlly.mjs";
export const kitNamespace = mlly;`,
  "graph/kit/utils.mjs": `export const kitVersion = () => "3";
export { resolvePath } from "./mlly.mjs";`,
  "graph/kit/mlly.mjs": `import { normalize } from "./pathe.mjs";
import ufo from "./ufo.cjs";
import { kitVersion } from "./index.mjs";
export function resolvePath(path) { return normalize(ufo.joinURL("/base", path)) + "@" + kitVersion(); }`,
  "graph/kit/pathe.mjs": `export const normalize = path => path.replace(/\\/+/g, "/");`,
  "graph/kit/ufo.cjs": `exports.joinURL = (base, path) => base + "//" + path;`,
  "graph/meta/a.mjs": `import { metaB } from "./b.mjs";
export { metaB };
export const metaA = import.meta.url.split("/").pop();`,
  "graph/meta/b.mjs": `import "./a.mjs";
export const metaB = import.meta.url.split("/").pop();`,
  "graph/names/fn.mjs": `export default function () {}`,
  "graph/names/cls.mjs": `export default class { static seen = this.name; }`,
  "graph/tdz/a.mjs": `import "./b.mjs"; import { c } from "./c.mjs"; export { c };`,
  "graph/tdz/b.mjs": `import { c } from "./a.mjs"; console.log("b:" + c);`,
  "graph/tdz/c.mjs": `export const c = "ready";`,
  "graph/tla/a.mjs": `import "./b.mjs"; import "./c.mjs"; globalThis.tlaEvents.push("a");`,
  "graph/tla/b.mjs": `import "./a.mjs"; globalThis.tlaEvents.push("b-start"); await globalThis.gate; globalThis.tlaEvents.push("b-end");`,
  "graph/tla/c.mjs": `import "./a.mjs"; globalThis.tlaEvents.push("c"); globalThis.openGate();`,
};

/** Node's result for the same files: native ES modules. */
function nativeResult(scratch: string): string {
  const dir = join(scratch, "native");
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  const output = execFileSync("node", [join(dir, "boot.mjs")], { encoding: "utf8", timeout: 30_000 });
  return /^graph (.*)$/m.exec(output)![1]!;
}

/** Every file the built site serves, as URL paths. */
function inventory(dir: string): Set<string> {
  const paths = new Set<string>();
  const walk = (at: string) => {
    for (const entry of readdirSync(at)) {
      const path = join(at, entry);
      if (statSync(path).isDirectory()) walk(path);
      else paths.add("/" + relative(dir, path).split("\\").join("/"));
    }
  };
  walk(dir);
  return paths;
}

type Request = { path: string; fromServiceWorker: boolean; status: number; blob: boolean };

function watchRequests(context: BrowserContext, origin: string): Request[] {
  const requests: Request[] = [];
  context.on("response", response => {
    const url = new URL(response.url());
    if (url.origin !== origin) return;
    // Evaluated records load as blob: modules; their origin is the page's.
    requests.push({ path: url.pathname, fromServiceWorker: response.fromServiceWorker(), status: response.status(), blob: url.protocol === "blob:" });
  });
  return requests;
}

async function guest(page: Page): Promise<{ code: number | null; output: string; controller: string; startup: boolean; graph: string | undefined }> {
  const checked = await run(page, "bun run records/boot.mjs", 120_000);
  const output: string = checked.output;
  return {
    code: checked.code,
    output,
    startup: /^startup /m.test(output),
    controller: /^controller (\S+)/m.exec(output)?.[1] ?? "missing",
    graph: /^graph (.*)$/m.exec(output)?.[1],
  };
}

async function unregister(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const registrations = await navigator.serviceWorker.getRegistrations();
    for (const registration of registrations) await registration.unregister();
    return registrations.length;
  });
}

const s = session("bwl-records-");
const deadline = setTimeout(() => { void s.cleanup().finally(() => process.exit(1)); }, 900_000);
let failures: string[] = [];
try {
  const expected = nativeResult(s.scratch);
  const served = inventory(root);
  const [, url] = await s.start(["serve.ts"], /at (http:\/\/\S+) \(cross-origin isolated\)/, { PORT: "0", ROOT: root });
  assert.ok(url, "the server printed no URL");
  const site = { url, origin: new URL(url).origin, served, expected };
  const browsers = process.argv.slice(2).length ? process.argv.slice(2) : ["chromium", "webkit"];
  for (const name of browsers) failures = failures.concat(await checkBrowser(name, site));
  assert.deepEqual(failures, []);
  console.log(expectOld ? "old loader fails the cycle graph after startup and probe" : "worker module records pass with and without a controller");
} finally {
  clearTimeout(deadline);
  await s.cleanup();
}

type Site = { url: string; origin: string; served: Set<string>; expected: string };
type Variant = Site & { name: string; variant: string };

async function checkBrowser(name: string, site: Site): Promise<string[]> {
  const browser = await s.launch(browserType(name));
  const problems: string[] = [];
  for (const variant of expectOld ? ["uncontrolled"] : ["uncontrolled", "controlled"]) {
    const problem = await checkVariant(browser, { ...site, name, variant });
    if (problem) problems.push(problem);
  }
  return problems;
}

// One fresh browser context: two guest processes, then the request, cache and control evidence.
async function checkVariant(browser: Browser, { name, variant, url, origin, served, expected }: Variant): Promise<string | undefined> {
  const context = await browser.newContext();
  const requests = watchRequests(context, origin);
  const page = await context.newPage();
  await page.goto(`${url}?engine=browser&prompt=off`);
  assert.match(await ready(page), /ready/);
  const removed = variant === "uncontrolled" ? await unregister(page) : 0;
  for (const [file, text] of Object.entries(files)) await writeFile(page, `/home/user/records/${file}`, text);
  const runs = [await guest(page), await guest(page)];
  const moduleCaches: string[] = await page.evaluate(async () => (await caches.keys()).filter((key: string) => key.startsWith("bunwasm-m-")));
  await context.close();
  const forbidden = requests.filter(request => request.path.includes("/__bunwasm/m/"));
  const blobModules = requests.filter(request => request.blob).length;
  const unserved = requests.filter(request => !request.blob && !served.has(decodeURIComponent(request.path)) && request.path !== "/" && !request.path.startsWith("/__preview/"));
  const scoped = requests.some(request => request.path === "/__bunwasm/worker.js");
  const workerServedBySw = requests.some(request => request.path.startsWith("/__bunwasm/") && request.fromServiceWorker);
  const evidence = { browser: name, variant, root, removedRegistrations: removed, scopedWorkerRequested: scoped, workerServedBySw, caches: moduleCaches, forbidden, unserved, blobModules, runs: runs.map(({ code, startup, controller, graph }) => ({ code, startup, controller, graph })) };
  console.log(JSON.stringify(evidence));
  const problem = expectOld ? oldProblems(runs, variant) : newProblems(runs, variant, expected, { forbidden, caches: moduleCaches, scoped, workerServedBySw, unserved });
  return problem && `${name} ${variant}: ${problem}\n${runs.map(guestRun => guestRun.output).join("\n---\n")}`;
}

function controllerProblem(controller: string, variant: string): string | undefined {
  if (controller === "missing") return "no controller probe output";
  if (variant === "uncontrolled" && controller !== "null" && controller !== "unavailable") return `controlled worker: ${controller}`;
  return undefined;
}

// A controlled page may still hand a process an uncontrolled worker (WebKit's second process
// does), so positive control needs one controlled process, or SW-served worker requests where
// workers have no container.
function positiveControl(runs: Awaited<ReturnType<typeof guest>>[], workerServedBySw: boolean): boolean {
  return runs.some(run => run.controller.endsWith("/sw.js") || (run.controller === "unavailable" && workerServedBySw));
}

function newProblems(runs: Awaited<ReturnType<typeof guest>>[], variant: string, expected: string, seen: { forbidden: Request[]; caches: string[]; scoped: boolean; workerServedBySw: boolean; unserved: Request[] }): string | undefined {
  if (!seen.scoped) return "the scoped worker URL was not requested";
  if (seen.forbidden.length) return `synthetic module routes requested: ${seen.forbidden.map(request => request.path).join(", ")}`;
  if (seen.unserved.length) return `requests outside the built site: ${seen.unserved.map(request => request.path).join(", ")}`;
  if (seen.caches.length) return `module caches left: ${seen.caches.join(", ")}`;
  if (variant === "controlled" && !positiveControl(runs, seen.workerServedBySw)) return "no positive control evidence";
  for (const [index, run] of runs.entries()) {
    if (!run.startup) return `process ${index + 1} did not start`;
    const controller = controllerProblem(run.controller, variant);
    if (controller) return `process ${index + 1}: ${controller}`;
    if (run.code !== 0 || run.graph !== expected) return `process ${index + 1}: exit ${run.code}, graph ${run.graph} (Node: ${expected})`;
  }
  return undefined;
}

// The old loader must reach the graph (startup and probe printed, worker uncontrolled) and fail
// there; a launch, asset or probe failure is not that regression.
function oldProblems(runs: Awaited<ReturnType<typeof guest>>[], variant: string): string | undefined {
  const [first] = runs;
  if (!first!.startup) return "old: the guest did not start";
  const controller = controllerProblem(first!.controller, variant);
  if (controller) return `old: ${controller}`;
  if (first!.code === 0 || first!.graph !== undefined) return "old: the cycle graph unexpectedly loaded";
  return undefined;
}
