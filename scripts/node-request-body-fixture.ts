import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInThisContext } from "node:vm";
import { URL as NativeURL } from "node:url";
import ts from "typescript-api";

function evaluate(code: string): unknown {
  const module = { exports: undefined };
  const load: unknown = runInThisContext(`(function(module) { ${code}\n})`);
  assert.ok(typeof load === "function");
  Reflect.apply(load, undefined, [module]);
  return module.exports;
}

function factory(name: string): (...args: unknown[]) => unknown {
  const source = readFileSync(new URL(`../crates/bunwasm-runtime/src/js/${name}`, import.meta.url), "utf8");
  const assignment = `module.exports = ${source}`;
  const value = evaluate(name.endsWith(".ts") ? ts.transpileModule(assignment, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText : assignment);
  assert.ok(typeof value === "function");
  return (...args) => Reflect.apply(value, undefined, args);
}

function urlParse(input: string, base?: string) {
  const url = NativeURL.parse(input, base);
  if (!url) return undefined;
  return [url.href, url.protocol, url.username, url.password, url.hostname, url.port, url.pathname, url.search, url.hash, url.origin];
}

export function requestBodyFixture(engine: "host" | "portable" = "portable") {
  const modules = new Map<string, unknown>([
    ["streams_polyfill", factory("streams_polyfill.js")()],
    ["url_search_params", factory("url_search_params.ts")()],
    ["web_brand", factory("web_brand.ts")()],
  ]);
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const internal = {
    native: {
      engine: engine === "host" ? "host" : "jsc",
      streams: { release() { throw new Error("Unexpected native codec release"); } },
      utf8Encode: (text: string) => encoder.encode(text),
      utf8Decode: (bytes: Uint8Array) => decoder.decode(bytes),
      urlParse, timeOrigin: () => 0,
      platformInfo: { version: "fixture", arch: "fixture" },
    },
    web: undefined,
    require(name: string): unknown {
      if (modules.has(name)) return modules.get(name);
      throw new Error(`Unexpected web factory dependency ${name}`);
    },
  };
  modules.set("body_streams", factory("body_streams.ts")(internal));
  modules.set("compression_streams", factory("compression_streams.ts")(internal));
  const streams = factory("streams.js")(internal);
  modules.set("streams", streams);
  factory("web.js")(internal);
  const web: unknown = internal.web;
  assert.ok(web && typeof web === "object" && "Request" in web && typeof web.Request === "function");
  const Constructor = web.Request;
  const create = (body: unknown, method = "POST"): object => {
    const request: unknown = Reflect.construct(Constructor, ["http://127.0.0.1/api/next", { method, headers: { "content-type": "application/json" }, body, duplex: "half" }]);
    assert.ok(request && typeof request === "object");
    return request;
  };
  assert.ok(streams && typeof streams === "object" && "ReadableStream" in streams && typeof streams.ReadableStream === "function");
  const Stream = streams.ReadableStream;
  if (engine === "host") assert.equal(Stream, globalThis.ReadableStream, "streams.js selects native Web streams");
  if (engine === "portable") assert.notEqual(Stream, globalThis.ReadableStream, "streams.js selects the portable implementation");
  function stream(bytes: Uint8Array): object {
    const value: unknown = Reflect.construct(Stream, [{ start(controller: ReadableStreamDefaultController<Uint8Array>) { controller.enqueue(bytes); controller.close(); } }]);
    assert.ok(value && typeof value === "object");
    return value;
  }
  return { create, stream };
}
