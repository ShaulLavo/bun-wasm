// HTML entry points use Bun's HTML parser and bundler, including linked JS,
// CSS and assets. The runtime only dispatches their output over Bun.serve.
(function (internal) {
  "use strict";
  const bundles = new WeakSet();
  const compiled = new WeakMap();

  function create(path) {
    const bundle = Object.freeze({ index: path, [Symbol.toStringTag]: "HTMLBundle" });
    bundles.add(bundle);
    return bundle;
  }

  function isBundle(value) {
    return value !== null && typeof value === "object" && bundles.has(value);
  }

  function compile(bundle) {
    if (compiled.has(bundle)) return compiled.get(bundle);
    const pending = build(bundle.index);
    compiled.set(bundle, pending);
    return pending;
  }

  async function build(path) {
    const result = await Bun.build({
      entrypoints: [path], target: "browser", publicPath: "/",
      define: { "process.env.NODE_ENV": JSON.stringify("development") },
    });
    if (!result.success) throw new AggregateError(result.logs, `Failed to bundle ${path}`);
    const files = new Map();
    let html = null;
    for (const output of result.outputs) {
      const name = new URL(output.path, "http://localhost/").pathname;
      const bytes = new Uint8Array(await output.arrayBuffer());
      const response = new Response(bytes, {
        headers: { "content-type": output.type, "content-length": String(bytes.length), "cache-control": "no-cache" },
      });
      if (output.loader === "html" || /\.html?$/.test(name)) html = response;
      else files.set(name, response);
    }
    if (!html) throw new Error(`HTML bundler produced no HTML for ${path}`);
    return { html, files };
  }

  function methodResponse(response, method) {
    if (method !== "GET" && method !== "HEAD") return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET, HEAD" } });
    return response.clone();
  }

  async function respond(bundle, pathname, method) {
    const output = await compile(bundle);
    return methodResponse(output.files.get(pathname) || output.html, method);
  }

  async function asset(routes, pathname, method) {
    for (const route of routes) {
      const handlers = isBundle(route.handler) ? [route.handler] : route.handler && typeof route.handler === "object" ? Object.values(route.handler).filter(isBundle) : [];
      for (const bundle of handlers) {
        const file = (await compile(bundle)).files.get(pathname);
        if (file) return methodResponse(file, method);
      }
    }
    return null;
  }

  async function start(path) {
    const bundle = create(path);
    await compile(bundle);
    const server = Bun.serve({ routes: { "/*": bundle } });
    console.log(`Started development server: ${server.url.href}`);
    return server;
  }

  return { create, isBundle, compile, respond, asset, start };
})
