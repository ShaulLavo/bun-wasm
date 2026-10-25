import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const directory = new URL("../crates/bunwasm-runtime/src/js/", import.meta.url);

export function requestCopyFactory(kind: "polyfill" | "native" = "polyfill") {
  const engine = kind === "native" ? "host" : "quickjs";
  const context = { Uint8Array, ArrayBuffer, SharedArrayBuffer, TypeError, RangeError, Error, queueMicrotask, TextEncoder, TextDecoder, Request };
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  function factory(name: string, extension = "ts") {
    const source = readFileSync(new URL(`${name}.${extension}`, directory), "utf8");
    const code = extension === "ts" ? transpiler.transformSync(`globalThis.factory = ${source}`) : source;
    return runInNewContext(code, context);
  }
  const streams: Pick<typeof globalThis, "ReadableStream" | "TransformStream"> = kind === "native" ? { ReadableStream, TransformStream } : factory("streams_polyfill", "js")();
  Object.assign(context, streams);
  const modules = new Map<string, unknown>([
    ["streams", streams], ["body_streams", factory("body_streams")({ native: { engine } })],
    ["url_search_params", factory("url_search_params")()], ["web_brand", () => {}],
    ["websocket", { clientClass: () => class {} }],
    ["compression_streams", { decode: (value: unknown) => value }],
    ["http_common", factory("http_common")()],
  ]);
  const sent: { meta: string; body: Uint8Array }[] = [];
  const closed: number[] = [];
  const internal = {
    web: { Request, Response, Headers },
    ioPending: () => 0,
    pumpIo: () => {},
    native: {
      engine, hostCaps: { fetch: true }, platformInfo: { version: "fixture", arch: "fixture" },
      timeOrigin: () => 0,
      utf8Encode: (text: string) => new TextEncoder().encode(text),
      utf8Decode: (bytes: Uint8Array) => new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes),
      urlParse(input: string, base?: string) {
        if (!URL.canParse(input, base)) return null;
        const url = new URL(input, base);
        return [url.href, url.protocol, url.username, url.password, url.hostname, url.port, url.pathname, url.search, url.hash, url.origin];
      },
      hostFetch(meta: string, body: Uint8Array) { sent.push({ meta, body }); return sent.length; },
      hostFetchHead: () => JSON.stringify({ status: 204, headers: [] }),
      hostClose(handle: number) { closed.push(handle); return 0; },
    },
    require(name: string): unknown {
      assert.ok(modules.has(name), `Unexpected module ${name}`);
      return modules.get(name);
    },
  };
  factory("web", "js")(internal);
  modules.set("fetch_lifetime", factory("fetch_lifetime")(internal));
  const net: { fetch: typeof fetch } = factory("net", "js")(internal);
  return { web: { Request: internal.web.Request, ReadableStream: streams.ReadableStream }, net, internal, sent, closed };
}
