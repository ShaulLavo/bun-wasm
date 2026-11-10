import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { generateDevelopmentHtmlClient } from "../../../scripts/generate-dev-html-client";

const root = new URL("../../../", import.meta.url);
function factory(name: string, globals: object = {}) {
  const source = readFileSync(new URL(`crates/bunwasm-runtime/src/js/${name}`, root), "utf8");
  const text = name.endsWith(".ts") ? new Bun.Transpiler({ loader: "ts" }).transformSync(`globalThis.factory = ${source}`) : source;
  return runInNewContext(text, { Uint8Array, ArrayBuffer, SharedArrayBuffer, DataView, TextEncoder, TextDecoder, URL, Response, Request, Headers, ReadableStream, AbortController, FinalizationRegistry, ...globals });
}

export async function developmentFixture() {
  const generated = await generateDevelopmentHtmlClient(new URL("web/src/dev-html-client.ts", root).pathname);
  const client: { source: string } = runInNewContext(generated)();
  const errors: unknown[] = [];
  let nextToken = 0;
  const modules = new Map<string, unknown>();
  const internal = {
    native: {
      engine: "quickjs", platformInfo: { version: "test", arch: "x64" }, hostCaps: {},
      utf8Encode: (text: string) => new TextEncoder().encode(text),
      utf8Decode: (data: Uint8Array, fatal: boolean) => new TextDecoder("utf-8", { fatal }).decode(data),
      timeOrigin: () => 0, now: () => 0,
      randomBytes: (length: number) => new Uint8Array(length).fill(++nextToken),
    },
    web: { Response },
    printError(error: unknown) { errors.push(error); },
    require(name: string): unknown {
      if (modules.has(name)) return modules.get(name);
      if (name === "streams") return { ReadableStream };
      if (name === "url_search_params") return {};
      if (name === "web_brand") return () => {};
      if (name === "dev_html_client") return client;
      // HTMLRewriter's native parser is the only HTML boundary replaced in source controls.
      if (name === "html_rewriter") return { HTMLRewriter: class {
        rewriter = new HTMLRewriter();
        on(selector: string, handlers: HTMLRewriterTypes.HTMLRewriterElementContentHandlers) { this.rewriter.on(selector, handlers); return this; }
        transform(text: string) { return this.rewriter.transform(new Response(text)).text(); }
      } };
      const value = factory(`${name}.ts`)(internal);
      modules.set(name, value);
      return value;
    },
  };
  factory("web.js")(internal);
  const GuestResponse: typeof Response = internal.web.Response;
  const adapt = factory("dev_html.ts", { Response: GuestResponse })(internal);
  const createSource = factory("hot_revisions.ts")(internal);
  return { client: client.source, GuestResponse, adapt, createSource, errors, writer: factory("http_response.ts")() };
}

export const counterHtml = '<!doctype html><html><head><meta charset="utf-8"><title>Counter</title></head><body><h1>Before</h1><button id="counter" disabled>Count</button><output id="value">0</output><script type="module" src="/counter.ts"></script></body></html>';
export const counterModule = `window.evaluations = (window.evaluations || 0) + 1;
const button = document.querySelector('#counter'); const value = document.querySelector('#value');
button.addEventListener('click', () => { value.textContent = String(Number(value.textContent) + 1); }); button.disabled = false;
window.original = { document, window, root: document.documentElement, head: document.head, body: document.body, button, value, url: location.href };`;

export async function developmentPageServer(initial = counterHtml, script = counterModule, socketShim?: string) {
  const fixture = await developmentFixture();
  const source = fixture.createSource();
  let stamp = source.stamp(1);
  source.commit(stamp);
  let html = initial;
  let rawRequests = 0;
  let privateOpened = 0;
  let adapter: ReturnType<typeof fixture.adapt.attach>;
  let rawStatus = 200;
  let rawType = "text/html";
  let withhold = false;
  let responseGate: Promise<void> | null = null;
  const headers = new Map<string, string>([["content-type", "text/html"]]);
  const server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(request, actual) {
      const path = new URL(request.url).pathname;
      if (path === "/away") return new Response("<!doctype html><title>Away</title><a href='/'>Return</a>", { headers: { "content-type": "text/html" } });
      if (path === "/shim.js" && socketShim) return new Response(socketShim, { headers: { "content-type": "text/javascript" } });
      if (path === "/counter.ts") return new Response(script, { headers: { "content-type": "text/javascript" } });
      if (path.endsWith("/events") && withhold) return new Response("handshake withheld", { status: 503 });
      const reserved = adapter.respond(request);
      if (reserved) return await platformResponse(reserved);
      if (adapter.upgrade(request, actual)) return;
      const captured = stamp;
      const body = html;
      const raw = request.headers.get("x-bun-wasm-dev-raw") === "1";
      if (raw) rawRequests++;
      const response = new fixture.GuestResponse(body, { status: raw ? rawStatus : 200, headers: Array.from(headers) });
      if (raw) response.headers.set("content-type", rawType);
      if (raw && responseGate) await responseGate;
      return await platformResponse(await adapter.decorate(request, response, captured));
    },
    websocket: {
      open(socket) { privateOpened++; adapter.websocket(undefined).open(socket); },
      message(socket, data) { adapter.websocket(undefined).message(socket, data); },
      close(socket, code, reason) { adapter.websocket(undefined).close(socket, code, reason); },
    },
  });
  adapter = fixture.adapt.attach({ server, revisions: source.source });
  async function platformResponse(response: Response): Promise<Response> {
    const output = new Response(await response.arrayBuffer(), { status: response.status, statusText: response.statusText, headers: Array.from(response.headers) });
    if (!socketShim || !output.headers.get("content-type")?.includes("text/html")) return output;
    return new HTMLRewriter().on("head", { element(token) { token.prepend(`<script src="/shim.js" data-bun-wasm-socket="shim" data-bun-port="${server.port}" data-bun-prefix="/__preview/"></script>`, { html: true }); } }).transform(output);
  }
  return {
    url: `http://127.0.0.1:${server.port}/`, source, adapter,
    get stamp() { return stamp; },
    get rawRequests() { return rawRequests; }, get privateOpened() { return privateOpened; },
    setHtml(next: string) { html = next; },
    commit(revision: number) { stamp = source.stamp(revision); source.commit(stamp); },
    unannounced(revision: number) { stamp = source.stamp(revision); },
    rawResponse(status: number, type = "text/html") { rawStatus = status; rawType = type; },
    policy(name: string, value: string) { headers.set(name, value); },
    withhold(value: boolean) { withhold = value; },
    gate(value: Promise<void> | null) { responseGate = value; },
    async close() { adapter.dispose(); source.close(); await server.stop(true); },
  };
}

export async function previewSocketShim(): Promise<string> {
  const result = await Bun.build({
    entrypoints: [new URL("web/src/preview-websocket-client.ts", root).pathname], target: "browser", format: "iife",
    plugins: [{ name: "actual-runtime-websocket", setup(build) {
      build.onResolve({ filter: /^bun-wasm:websocket$/ }, () => ({ path: "websocket", namespace: "runtime-socket" }));
      build.onLoad({ filter: /.*/, namespace: "runtime-socket" }, () => ({ contents: `export default ${readFileSync(new URL("crates/bunwasm-runtime/src/js/websocket.ts", root), "utf8")}`, loader: "ts" }));
    } }],
  });
  if (!result.success || result.outputs.length !== 1) throw new AggregateError(result.logs, "Cannot build existing preview shim");
  return result.outputs[0]!.text();
}
