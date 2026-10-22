import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";

const require = createRequire(import.meta.url);
const transpiler = new Bun.Transpiler({ loader: "ts" });

function factory(name: string): (...args: unknown[]) => unknown {
  const source = readFileSync(new URL(`../crates/bunwasm-runtime/src/js/${name}`, import.meta.url), "utf8");
  const code = name.endsWith(".ts") ? transpiler.transformSync(`globalThis.__fixtureFactory = ${source}`) : source;
  const value: unknown = runInNewContext(code, { TextEncoder, Uint8Array, ArrayBuffer, DataView, URL, Buffer });
  assert.ok(typeof value === "function");
  return (...args) => Reflect.apply(value, undefined, args);
}

export function responseFixture() {
  const common = factory("http_common.ts")();
  const agent = factory("http_agent.ts")();
  const internal = {
    native: { hostCaps: {} },
    web: { Request, Response, Headers },
    builtinFactories: {},
    builtin: require,
    nextTick: queueMicrotask,
    require(name: string): unknown {
      if (name === "http_common") return common;
      if (name === "http_agent") return agent;
      if (name === "websocket") return { clientClass: () => class {} };
      return require(name);
    },
  };
  const network = factory("net.js")(internal);
  assert.ok(network && typeof network === "object" && "nodeHttp" in network && typeof network.nodeHttp === "function");
  const http: unknown = network.nodeHttp("http:");
  assert.ok(http && typeof http === "object" && "ServerResponse" in http && typeof http.ServerResponse === "function");
  const Constructor = http.ServerResponse;
  const wire: Buffer[] = [];
  function create(): object {
    const connection = { write(bytes: Uint8Array, callback?: () => void) {
      wire.push(Buffer.from(bytes));
      if (callback) queueMicrotask(callback);
    } };
    const response: unknown = Reflect.construct(Constructor, [connection, { method: "GET", httpVersion: "1.1" }, false, () => {}]);
    assert.ok(response && typeof response === "object");
    return response;
  }
  return { create, wire };
}
