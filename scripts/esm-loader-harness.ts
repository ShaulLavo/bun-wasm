// Runs the ES module loader for engines without native modules
// (crates/bunwasm-runtime/src/js/esm_loader.ts) over the fixtures in
// tests/fixtures/esm-loader: each case's modules, already turned into
// registration records by bunwasm-transpiler (records.json), become one plain
// script with tiny resolve/load/import.meta natives. Any engine that runs a
// script can run it: Bun or Node here, a Hermes build for the prototype.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const fixturesDir = join(import.meta.dir, "../tests/fixtures/esm-loader");
const loaderPath = join(import.meta.dir, "../crates/bunwasm-runtime/src/js/esm_loader.ts");

export type Records = { modules: Record<string, string>; cjs: Record<string, string> };

export function fixtureCases(): string[] {
  return readdirSync(fixturesDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort();
}

export function readRecords(name: string): Records {
  return JSON.parse(readFileSync(join(fixturesDir, name, "records.json"), "utf8"));
}

// The loader file is one function expression; assigning it keeps the
// transpiler from dropping it as an unused expression.
export function loaderSource(): string {
  const prefix = "globalThis.factory = ";
  const out = new Bun.Transpiler({ loader: "ts" }).transformSync(prefix + readFileSync(loaderPath, "utf8"));
  return out.slice(out.indexOf(prefix) + prefix.length).trim().replace(/;$/, "");
}

// Shells with a global \`print\` (the Hermes CLI) print through it, and
// their setTimeout ignores the delay: order timers by due time on a virtual
// clock, one shell timer per due callback.
const prelude = `
if (typeof print === "function") {
  globalThis.console = { log: (...args) => print(args.map(String).join(" ")) };
  const shellTimeout = globalThis.setTimeout;
  const timers = [];
  let now = 0, seq = 0;
  const fire = () => {
    timers.sort((a, b) => a.due - b.due || a.seq - b.seq);
    const timer = timers.shift();
    now = Math.max(now, timer.due);
    timer.callback();
  };
  globalThis.setTimeout = (callback, delay = 0) => {
    timers.push({ callback, due: now + Math.max(0, delay), seq: seq++ });
    shellTimeout(fire, 0);
  };
}
`;

const natives = `
const handoffs = new Map();
function normalize(path) {
  const parts = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop(); else parts.push(part);
  }
  return "/" + parts.join("/");
}
const native = {
  esmResolve(specifier, referrer) {
    const base = referrer === "" ? "/" : referrer.slice(0, referrer.lastIndexOf("/") + 1);
    const name = normalize(specifier.startsWith("/") ? specifier : base + specifier);
    if (!(name in records)) throw new Error("Cannot find module '" + specifier + "' from '" + referrer + "'");
    return name;
  },
  esmSource(name) {
    const factory = cjs[name];
    if (factory !== undefined) {
      const module = { exports: {} };
      factory.call(module.exports, module.exports, undefined, module, name, name.slice(0, name.lastIndexOf("/")));
      handoffs.set(name, { value: module.exports, default: module.exports });
    }
    return name;
  },
  esmEvalScript(code) {
    return records[code];
  },
  esmInitMeta(name, meta) {
    const handoff = handoffs.get(name);
    handoffs.delete(name);
    if (handoff !== undefined) meta.m = handoff;
    else meta.url = "file://" + name;
  },
};
`;

export function harnessSource(name: string, loader = loaderSource()): string {
  const { modules, cjs } = readRecords(name);
  const records = Object.entries(modules).map(([path, code]) => `${JSON.stringify(path)}: ${code}`);
  const factories = Object.entries(cjs).map(
    ([path, code]) => `${JSON.stringify(path)}: (function (exports, require, module, __filename, __dirname) {\n${code}\n})`,
  );
  return [
    prelude,
    `const records = {\n${records.join(",\n")}\n};`,
    `const cjs = {\n${factories.join(",\n")}\n};`,
    natives,
    `const loader = (${loader})({ native });`,
    `loader.importModule("/main.mjs", "").then(undefined, error => console.log("<rejected>", error && error.message));`,
  ].join("\n");
}
