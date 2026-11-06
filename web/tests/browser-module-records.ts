// Worker module loading with and without a service-worker controller, through the built
// playground's Bun launcher.
//
// Each guest process runs the same acyclic bootstrap (`files["boot.mjs"]`): it prints `startup`,
// a token, the executing worker's location and service-worker capability (`unavailable` when
// the worker exposes no container, never read as null), and fetches a probe with the worker's
// native fetch, then dynamically imports a graph of import cycles and prints its result, which
// must equal Node's for the same files. Two processes run in sequence in each context; the
// second runs on the pool's spare worker.
//
//   bun web/tests/browser-module-records.ts [chromium] [webkit]
//   MODULE_RECORDS_ROOT=<built web dir>   serve another build (default web/dist)
//   MODULE_RECORDS_EXPECT=old             that build is the old loader: in both uncontrolled
//                                          contexts, both processes must start, print the probe
//                                          and then fail on the cycle with a 404 for its module
//                                          route (a launch, asset or probe failure is not that)
//
// Contexts, each a fresh browser context:
//   blocked       Playwright blocks service workers for the context; no registration exists
//   unregistered  the page registers its service worker, which is removed before the first
//                 command, so workers start outside its control (the iPhone case)
//   controlled    the registration stays. Where the browser controls a page's Bun workers
//                 (WebKit, `controlsWorkers`), at least one process must show positive control
//                 of its own worker: a controller, or (where workers expose no container) its
//                 probe answered by the service worker. Each process's state is reported as is.
//
// Evidence is attributed per process: requests seen while that process ran, its probe's
// response (matched by token), and the executing worker's own report of its location. (The
// guest's idle workers block in Atomics.wait, so Playwright cannot evaluate in them.)
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright";
import { browserType } from "./browser-type.ts";
import { ready, run, session, web, writeFile } from "./playground.mjs";

const root = process.env.MODULE_RECORDS_ROOT ?? join(web, "dist");
const expectOld = process.env.MODULE_RECORDS_EXPECT === "old";

// Whether a controlled page's Bun workers are themselves controlled. Observed (2026-11-06,
// Playwright Chromium and WebKit): WebKit's first worker reports the controller and its probe is
// answered by the service worker; Chromium's workers expose no container and their probes come
// from the network although the service worker served their script. So Chromium gives no
// positive proof for an executing worker, and its controlled context only shows that the
// loader works on a controlled page.
const controlsWorkers: Record<string, boolean> = { chromium: false, webkit: true };

const files: Record<string, string> = {
  // Acyclic: startup, then the executing worker's own identity, service-worker capability and a
  // probe fetched with the worker's native fetch, and only then the import cycles. The probe is
  // under the module scope (`/__bunwasm/`), which the service worker answers for every client it
  // controls, so the probe's response shows whether a service worker controls this worker.
  "boot.mjs": `console.log("startup", typeof Bun);
const token = Math.random().toString(36).slice(2);
const scope = globalThis.WorkerGlobalScope?.prototype;
const own = name => scope && Object.getOwnPropertyDescriptor(scope, name);
const workerNavigator = own("navigator")?.get?.call(globalThis);
const container = workerNavigator && "serviceWorker" in workerNavigator ? workerNavigator.serviceWorker : undefined;
console.log("controller", container == null ? "unavailable" : container.controller === null ? "null" : container.controller.scriptURL);
const location = own("location")?.get?.call(globalThis);
console.log("worker", token, location ? location.href : "none");
const nativeFetch = own("fetch")?.value;
const probe = nativeFetch && location ? await nativeFetch.call(globalThis, location.origin + "/__bunwasm/worker.js?bwl-probe=" + token, { cache: "no-store" }) : undefined;
console.log("probe", token, probe ? probe.status : "none");
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

type Request = { path: string; query: string; fromServiceWorker: boolean; status: number; blob: boolean };

function watchRequests(context: BrowserContext, origin: string): Request[] {
  const requests: Request[] = [];
  context.on("response", response => {
    const url = new URL(response.url());
    if (url.origin !== origin) return;
    // Evaluated records load as blob: modules; their origin is the page's.
    requests.push({ path: url.pathname, query: url.search, fromServiceWorker: response.fromServiceWorker(), status: response.status(), blob: url.protocol === "blob:" });
  });
  return requests;
}

type GuestRun = {
  code: number | null; output: string; startup: boolean; controller: string; token: string | undefined;
  location: string | undefined; probe: string | undefined; graph: string | undefined; failure: string | undefined;
};

async function guest(page: Page): Promise<GuestRun> {
  const checked = await run(page, "bun run records/boot.mjs", 120_000);
  const output: string = checked.output;
  const worker = /^worker (\S+) (\S+)$/m.exec(output);
  return {
    code: checked.code,
    output,
    startup: /^startup /m.test(output),
    controller: /^controller (\S+)/m.exec(output)?.[1] ?? "missing",
    token: worker?.[1],
    location: worker?.[2],
    probe: /^probe \S+ (\S+)$/m.exec(output)?.[1],
    graph: /^graph (.*)$/m.exec(output)?.[1],
    // The first error line after the probe: what stopped the graph.
    failure: /^probe .*$/m.test(output) ? /^.*(?:Error|error:|ERR_).*$/m.exec(output.slice(output.search(/^probe /m)))?.[0] : undefined,
  };
}

async function registrations(page: Page): Promise<number | "unavailable"> {
  return page.evaluate(async () => navigator.serviceWorker ? (await navigator.serviceWorker.getRegistrations()).length : "unavailable");
}

async function unregister(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const found = await navigator.serviceWorker.getRegistrations();
    for (const registration of found) await registration.unregister();
    return found.length;
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
  console.log(expectOld ? "old loader fails the cycle graph in both processes, after startup and probe" : "worker module records pass in blocked, unregistered and controlled contexts");
} finally {
  clearTimeout(deadline);
  await s.cleanup();
}

type Site = { url: string; origin: string; served: Set<string>; expected: string };
type Context = "blocked" | "unregistered" | "controlled";
type Variant = Site & { name: string; context: Context };

/** One process's attributed evidence. */
type ProcessEvidence = {
  /** The executing worker's own report: its script location and the token it printed and fetched. */
  code: number | null; startup: boolean; controller: string; location: string | undefined; token: string | undefined;
  probe: string | undefined; probeServedBySw: boolean | "no probe response"; graph: string | undefined; failure: string | undefined;
  /** Retired module-store routes requested while it ran, and their statuses. */
  moduleRoutes: string[]; blobModules: number; unserved: string[];
  /** How its own worker was controlled: by a controller, by a service worker that served its probe, or not. */
  control: string;
};

async function checkBrowser(name: string, site: Site): Promise<string[]> {
  const browser = await s.launch(browserType(name));
  const problems: string[] = [];
  const contexts: Context[] = expectOld ? ["blocked", "unregistered"] : ["blocked", "unregistered", "controlled"];
  for (const context of contexts) {
    const problem = await checkVariant(browser, { ...site, name, context });
    if (problem) problems.push(problem);
  }
  return problems;
}

function control(controller: string, probeServedBySw: boolean | "no probe response"): string {
  if (controller.endsWith("/sw.js")) return "controlled (controller)";
  if (controller === "unavailable" && probeServedBySw === true) return "controlled (probe served by the service worker; no worker container)";
  if (probeServedBySw === true) return `served by the service worker but controller ${controller}`;
  return controller === "unavailable" ? "not controlled (no worker container, probe from the network)" : "not controlled (controller null)";
}

// One fresh browser context: two guest processes in sequence, each with its own requests,
// probe and executing worker, then the context's registrations and caches.
async function checkVariant(browser: Browser, { name, context: policy, url, origin, served, expected }: Variant): Promise<string | undefined> {
  const context = await browser.newContext({ serviceWorkers: policy === "blocked" ? "block" : "allow" });
  const requests = watchRequests(context, origin);
  const page = await context.newPage();
  await page.goto(`${url}?engine=browser&prompt=off`);
  assert.match(await ready(page), /ready/);
  const removed = policy === "unregistered" ? await unregister(page) : 0;
  const registered = await registrations(page);
  for (const [file, text] of Object.entries(files)) await writeFile(page, `/home/user/records/${file}`, text);
  const processes: ProcessEvidence[] = [];
  for (let index = 0; index < 2; index++) {
    const start = requests.length;
    const guestRun = await guest(page);
    const seen = requests.slice(start);
    const probe = seen.find(request => guestRun.token !== undefined && request.query === `?bwl-probe=${guestRun.token}`);
    const probeServedBySw = probe ? probe.fromServiceWorker : "no probe response";
    processes.push({
      code: guestRun.code, startup: guestRun.startup, controller: guestRun.controller, location: guestRun.location,
      token: guestRun.token, probe: guestRun.probe, probeServedBySw, graph: guestRun.graph, failure: guestRun.failure,
      moduleRoutes: seen.filter(request => request.path.includes("/__bunwasm/m/")).map(request => `${request.status} ${decodeURIComponent(request.path)}`),
      blobModules: seen.filter(request => request.blob).length,
      unserved: seen.filter(request => !request.blob && !served.has(decodeURIComponent(request.path)) && request.path !== "/" && !request.path.startsWith("/__preview/") && !request.path.includes("/__bunwasm/m/")).map(request => request.path),
      control: control(guestRun.controller, probeServedBySw),
    });
    if (processes[index]!.code === null) break;
  }
  // Logical cleanup: both processes reported their exit, and no module cache exists. Closing the
  // context says nothing about when its workers physically retire, so nothing is inferred from it.
  const moduleCaches: string[] = await page.evaluate(async () => (await caches.keys()).filter((key: string) => key.startsWith("bunwasm-m-")));
  const scoped = requests.some(request => request.path === "/__bunwasm/worker.js");
  await context.close();
  console.log(JSON.stringify({ browser: name, context: policy, root, removedRegistrations: removed, registrations: registered, scopedWorkerRequested: scoped, caches: moduleCaches, processes }));
  const problem = expectOld ? oldProblems(processes, policy) : newProblems(processes, policy, name, expected, { registered, caches: moduleCaches });
  return problem && `${name} ${policy}: ${problem}`;
}

function newProblems(processes: ProcessEvidence[], policy: Context, browserName: string, expected: string, seen: { registered: number | "unavailable"; caches: string[] }): string | undefined {
  if (processes.length !== 2) return "the first process did not finish";
  if (policy === "blocked" && seen.registered !== 0) return `service worker registrations in a blocked context: ${String(seen.registered)}`;
  if (seen.caches.length) return `module caches left: ${seen.caches.join(", ")}`;
  for (const [index, process] of processes.entries()) {
    const label = `process ${index + 1}`;
    if (!process.startup || process.probe === undefined) return `${label} did not start and probe`;
    if (process.moduleRoutes.length) return `${label} requested module routes: ${process.moduleRoutes.join(", ")}`;
    if (process.unserved.length) return `${label} requested files outside the built site: ${process.unserved.join(", ")}`;
    if (process.code !== 0 || process.graph !== expected) return `${label}: exit ${process.code}, graph ${process.graph} (Node: ${expected})`;
    if (policy !== "controlled" && process.control.startsWith("controlled")) return `${label} was controlled in a ${policy} context: ${process.control}`;
    if (policy !== "controlled" && process.probeServedBySw !== false) return `${label}'s probe was not a network response: ${String(process.probeServedBySw)}`;
  }
  // A controlled page may still hand a process an uncontrolled worker (WebKit's second process
  // does), which is reported as such. Where the browser controls executing workers at all, at
  // least one process must show its own worker controlled.
  if (policy === "controlled" && controlsWorkers[browserName] && !processes.some(process => process.control.startsWith("controlled"))) return "no process showed positive control of its own worker";
  return undefined;
}

// The old loader must reach the graph in both processes (startup and probe printed, worker not
// controlled) and fail there on the cycle, in one of its two ways: with its module store, the
// cycle's module route 404s outside service-worker control (the iPhone failure); without a store
// (service workers blocked), the cycle is its ERR_CIRCULAR_IMPORT error. A launch, asset or probe
// failure is not that regression.
function oldProblems(processes: ProcessEvidence[], policy: Context): string | undefined {
  if (processes.length !== 2) return "old: the first process did not finish";
  for (const [index, process] of processes.entries()) {
    const label = `old process ${index + 1}`;
    if (!process.startup || process.probe === undefined) return `${label} did not start and probe`;
    if (process.control.startsWith("controlled")) return `${label} was controlled: ${process.control}`;
    if (process.code === 0 || process.graph !== undefined) return `${label}: the cycle graph loaded`;
    const routeMissing = process.moduleRoutes.some(route => /^404 \/__bunwasm\/m\/.*\/graph\/main\.mjs$/.test(route));
    const circular = /Circular ES module imports|ERR_CIRCULAR_IMPORT/.test(process.failure ?? "");
    if (policy === "unregistered" && !routeMissing) return `${label}: no 404 for the cycle's module route (${process.moduleRoutes.join(", ") || "none"}; ${process.failure})`;
    if (policy === "blocked" && (!circular || process.moduleRoutes.length)) return `${label}: not the store-less cycle error (${process.failure}; routes ${process.moduleRoutes.join(", ") || "none"})`;
  }
  return undefined;
}
