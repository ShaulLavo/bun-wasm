#!/usr/bin/env node
import { appendFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { join } from "node:path";

function fixtureRoot(): string {
  const path = process.env.STACK_TEST_ROOT;
  if (!path) throw new Error("Missing STACK_TEST_ROOT");
  return path;
}
const root = fixtureRoot();
const scenario = process.env.STACK_TEST_SCENARIO ?? "safe";
let serial = 0;

function resource(kind: string) {
  const path = join(root, `${kind}-${serial++}`);
  mkdirSync(path);
  return async () => {
    rmSync(path, { recursive: true, force: true });
    appendFileSync(join(root, "cleanup.log"), `${kind}\n`);
  };
}

export const playwright = { devices: {}, chromium: {}, webkit: {}, firefox: {} };
export const firstVisit = async (_context: unknown, url: string) => ({ url, close: resource("visit") });
export const ready = async () => {};
export const writeFile = async () => {};
function fakeContext() {
  return { close: resource("context"), newPage: async () => ({ goto: async () => {} }) };
}
function fakeBrowser() {
  return { close: resource("browser"), newContext: async () => fakeContext() };
}
export function session() {
  const cleanup = resource("session");
  return { serve: async () => "http://fake.invalid/", cleanup, launch: async () => fakeBrowser() };
}

function attempt(mode: string, depth: number) {
  if (process.env.STACK_TEST_OUTPUT !== undefined) {
    const output = process.env.STACK_TEST_OUTPUT.replaceAll("{mode}", mode).replaceAll("{depth}", String(depth));
    return { code: Number(process.env.STACK_TEST_STATUS ?? 0), output };
  }
  if (scenario === "throw") throw new Error("fake provider failure");
  if (scenario === "hidden-timeout" && mode === "plain" && depth === 100000) return { code: null, output: "timeout" };
  if (scenario === "timeout") return { code: null, output: "timeout" };
  if (scenario === "hidden" && mode === "plain" && (depth === 100000 || depth === 4)) return { code: 1, output: "wasm call stack exhausted" };
  if (scenario === "final" && mode === "plain") return { code: 1, output: "wasm call stack exhausted" };
  if (scenario === "missing") return { code: 0, output: `completed ${mode} ${depth}\n` };
  if (scenario === "wrong-depth") return { code: 0, output: `completed ${mode} ${depth + 1}\ncontinued\n` };
  const caught = scenario === "unexpected" ? "TypeError" : "RangeError";
  if (scenario === "unexpected" || (mode === "plain" && depth > 2)) return { code: 0, output: `caught ${mode} ${caught} ${depth} stack overflow\ncontinued\n` };
  return { code: 0, output: `completed ${mode} ${depth}\ncontinued\n` };
}

export async function run(_page: unknown, command: string) {
  const match = /depth\.js (\w+) (\d+)$/.exec(command);
  if (match) return attempt(match[1]!, Number(match[2]));
  const fixture = /bun run (stack-overflow(?:-console)?)\.js$/.exec(command);
  if (!fixture) throw new Error(`Unexpected command ${command}`);
  return { code: 0, output: readFileSync(new URL(`../../tests/fixtures/${fixture[1]}/expected.txt`, import.meta.url), "utf8") };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const mode = process.argv.at(-2)!;
  const depth = Number(process.argv.at(-1));
  appendFileSync(join(root, "launcher.pid"), `${process.pid}\n`);
  if (scenario === "hang" || (scenario === "hidden-timeout" && depth === 4)) await new Promise(() => setInterval(() => {}, 1000));
  const result = attempt(mode, depth);
  process.stdout.write(result.output);
  process.exitCode = result.code ?? 1;
} else {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "./playground.mjs" || specifier === "./first-visit.mjs") return { url: import.meta.url, shortCircuit: true };
      return nextResolve(specifier, context);
    },
  });
}
