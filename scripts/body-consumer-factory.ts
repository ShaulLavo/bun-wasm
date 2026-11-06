import { readFileSync } from "node:fs";

export function bodyConsumerSources() {
  const directory = new URL("../crates/bunwasm-runtime/src/js/", import.meta.url);
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const load = (name: string, extension = "ts") => {
    const source = readFileSync(new URL(`${name}.${extension}`, directory), "utf8");
    return extension === "ts" ? transpiler.transformSync(`const factory = ${source};`) + "\nreturn factory;" : `return (
${source}
);`;
  };
  return { body: load("body_streams"), web: load("web", "js"), url: load("url_search_params"), brand: load("web_brand"), consumers: load("stream_consumers") };
}

export function bodyConsumerFactory(sources: ReturnType<typeof bodyConsumerSources>) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const modules = new Map<string, unknown>([
    ["streams", { ReadableStream, TransformStream, WritableStream }],
    ["url_search_params", new Function(sources.url)()()],
    ["web_brand", new Function(sources.brand)()()],
    ["buffer", { Buffer: { from: (bytes: ArrayBuffer) => new Uint8Array(bytes) } }],
  ]);
  const internal = {
    native: {
      engine: "host", platformInfo: { version: "probe", arch: "probe" }, hostCaps: { fetch: false },
      utf8Encode: (text: string) => encoder.encode(text), utf8Decode: (bytes: Uint8Array) => decoder.decode(bytes),
      timeOrigin: () => 0, now: () => 0,
      urlParse(input: string, base?: string) {
        if (!URL.canParse(input, base)) return null;
        const url = new URL(input, base);
        return [url.href, url.protocol, url.username, url.password, url.hostname, url.port, url.pathname, url.search, url.hash, url.origin];
      },
    },
    require(name: string): unknown {
      if (!modules.has(name)) throw new Error(`Unexpected module ${name}`);
      return modules.get(name);
    },
  };
  const body: { values<T>(stream: ReadableStream<T>): AsyncGenerator<T, void, unknown> } = new Function(sources.body)()(internal);
  modules.set("body_streams", body);
  new Function(sources.web)()(internal);
  const web: {
    Response: new (body?: unknown) => Response;
    Request: new (url: string, init: { method: string; body: unknown; duplex: string }) => Request;
  } = Reflect.get(internal, "web");
  const consumers: {
    text(stream: unknown): Promise<string>;
    blob(stream: unknown): Promise<Blob>;
    bytes(stream: unknown): Promise<Uint8Array>;
  } = new Function(sources.consumers)()(internal);
  return { web, consumers, body };
}
