import { readFileSync } from "node:fs";
import { inspect } from "node:util";
import { createContext, runInContext } from "node:vm";

const directory = new URL("../crates/bunwasm-runtime/src/js/", import.meta.url);
const transpiler = new Bun.Transpiler({ loader: "ts" });

export function eventTargetSource(globals: Record<string, unknown> = {}, overrides: object = {}, emitted?: string) {
  const lines: string[] = [];
  const ticks: (() => void)[] = [];
  const internal = {
    native: { timeOrigin: () => performance.timeOrigin, now: () => performance.now(), platformInfo: { version: Bun.version, arch: process.arch } },
    nextTick: (callback: () => void) => ticks.push(callback),
    web: { Event, EventTarget, AbortController, AbortSignal },
    require(name: string): unknown {
      if (name === "text_decoder") return TextDecoder;
      if (name === "web_brand") return runInContext(transpiler.transformSync(`globalThis.brandFactory = ${readFileSync(new URL("web_brand.ts", directory), "utf8")}`), context)();
      if (name === "inspect") return { nodeInspect: inspect };
      return {};
    },
  };
  const context = createContext({ internal, queueMicrotask,
    console: { log: (...values: unknown[]) => lines.push(values.map(String).join(" ")) }, ...globals });
  runInContext(readFileSync(new URL("web.js", directory), "utf8"), context)(internal);
  Object.assign(context, internal.web);
  Object.assign(internal, overrides);
  const factory = emitted ?? transpiler.transformSync(`globalThis.eventsFactory = ${readFileSync(new URL("events.ts", directory), "utf8")}`);
  const events = runInContext(factory, context)(internal);
  Object.assign(context, { events });
  return { context, lines, ticks, events, web: internal.web };
}
