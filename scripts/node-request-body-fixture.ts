import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInThisContext } from "node:vm";
import { URL as NativeURL } from "node:url";

const transpiler = new Bun.Transpiler({ loader: "ts" });
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
  const value = evaluate(name.endsWith(".ts") ? transpiler.transformSync(assignment) : assignment);
  assert.ok(typeof value === "function");
  return (...args) => Reflect.apply(value, undefined, args);
}

function urlParse(input: string, base?: string) {
  const url = NativeURL.parse(input, base);
  if (!url) return undefined;
  return [url.href, url.protocol, url.username, url.password, url.hostname, url.port, url.pathname, url.search, url.hash, url.origin];
}

export function requestBodyFixture() {
  const streams = factory("streams_polyfill.js")();
  const bodyStreams = factory("body_streams.ts")();
  const brand = factory("web_brand.ts")();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const internal = {
    native: {
      utf8Encode: (text: string) => encoder.encode(text),
      utf8Decode: (bytes: Uint8Array) => decoder.decode(bytes),
      urlParse, timeOrigin: () => 0,
      platformInfo: { version: "fixture", arch: "fixture" },
    },
    web: undefined,
    require(name: string): unknown {
      if (name === "streams") return streams;
      if (name === "body_streams") return bodyStreams;
      if (name === "web_brand") return brand;
      throw new Error(`Unexpected web factory dependency ${name}`);
    },
  };
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
  function stream(bytes: Uint8Array): object {
    const value: unknown = Reflect.construct(Stream, [{ start(controller: ReadableStreamDefaultController<Uint8Array>) { controller.enqueue(bytes); controller.close(); } }]);
    assert.ok(value && typeof value === "object");
    return value;
  }
  return { create, stream };
}
