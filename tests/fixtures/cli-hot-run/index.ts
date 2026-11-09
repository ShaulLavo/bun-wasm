import fs from "node:fs";
import { createRequire, Module } from "node:module";
import page from "./page.html" with { type: "text" };
import { word } from "./dependency.ts";

type FixtureState = {
  runs: number;
  server: ReturnType<typeof Bun.serve> | null;
  port: number;
  sentinel: object;
  hold: (() => void) | null;
  holding: boolean;
};
const globals = globalThis as typeof globalThis & { hotFixture?: FixtureState };
const first = globals.hotFixture === undefined;
const state = globals.hotFixture ??= {
  runs: 0, server: null, port: 20000 + (process.pid % 30000), sentinel: {}, hold: null, holding: false,
};
for (const requireFile of [import.meta.require, createRequire(import.meta.url), new Module(import.meta.path).require.bind(new Module(import.meta.path))]) {
  let rejected = false;
  try { requireFile("./forbidden.cjs"); } catch (error) { rejected = error instanceof TypeError && error.message.includes("--hot"); }
  if (!rejected || Reflect.has(globalThis, "forbiddenHotEffect")) throw new Error("file require escaped hot preparation");
}
const run = ++state.runs;
const sentinel = state.sentinel;
const server = Bun.serve({
  hostname: "127.0.0.1", port: state.port,
  async fetch(request) {
    if (new URL(request.url).searchParams.has("hold")) {
      state.holding = true;
      await new Promise<void>(resolve => { state.hold = resolve; });
    }
    return new Response(`${page.trim()}|${word}|${run}`, { headers: {
      "x-pid": String(process.pid), "x-same-server": String(server === state.server),
      "x-sentinel": String(sentinel === state.sentinel),
    } });
  },
});
state.server ??= server;

function assert(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(label);
}
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const base = `http://127.0.0.1:${state.port}/`;
async function response() {
  const result = await fetch(base);
  assert(result.headers.get("x-pid") === String(process.pid), "same process");
  assert(result.headers.get("x-same-server") === "true", "identical actual server");
  assert(result.headers.get("x-sentinel") === "true", "same realm globals");
  return result.text();
}
async function until(body: string) {
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    const actual = await response();
    if (actual === body) return;
    await delay(5);
  }
  throw new Error(`response did not reach ${body}`);
}
async function driver() {
  assert(await response() === "before|word|1", "initial response");
  console.log("initial same process, realm and server");
  fs.writeFileSync("unimported.txt", "not a graph input");
  await delay(50);
  assert(state.runs === 1, "unimported write did not reload");
  fs.writeFileSync("page.html", "after!\n");
  await until("after!|word|2");
  console.log("equal-length text edit");
  fs.writeFileSync("replacement.html", "atomic\n");
  fs.renameSync("replacement.html", "page.html");
  await until("atomic|word|3");
  console.log("atomic replacement");
  const pending = fetch(base + "?hold=1").then(result => result.text());
  while (!state.holding) await delay(1);
  fs.writeFileSync("page.html", "newest\n");
  await until("newest|word|4");
  state.hold!();
  assert(await pending === "atomic|word|3", "old request retained its graph through commit");
  console.log("request spans commit");
  fs.writeFileSync("dependency.ts", "export const word = ;\n");
  await delay(100);
  assert(await response() === "newest|word|4", "compile error kept the last committed callback");
  assert(state.runs === 4, "static compile failure ran no entry body");
  fs.writeFileSync("dependency.ts", 'export const word = "fixed";\n');
  await until("newest|fixed|5");
  console.log("compile error recovery");
  process.exit(0);
}

if (first) {
  setTimeout(() => void driver().catch(error => { console.error(error); process.exit(1); }), 10);
  setTimeout(() => { console.error("hot fixture deadline"); process.exit(1); }, 50000).unref();
}
