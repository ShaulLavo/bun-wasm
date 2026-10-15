// HTML entry points use Bun's HTML parser and bundler, including linked JS,
// CSS and assets. The runtime only dispatches their output over Bun.serve.
(function (internal) {
  "use strict";
  const bundles = new WeakSet();
  const compiled = new WeakMap();
  const servers = new WeakMap();
  const hmr = Symbol("Bun HMR socket");
  const encoder = new TextEncoder();

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

  async function respond(bundle, pathname, method, server) {
    const output = await outputFor(bundle, server);
    return methodResponse(output.files.get(pathname) || output.html, method);
  }

  async function asset(routes, pathname, method, server) {
    for (const route of routes) {
      const handlers = isBundle(route.handler) ? [route.handler] : route.handler && typeof route.handler === "object" ? Object.values(route.handler).filter(isBundle) : [];
      for (const bundle of handlers) {
        const file = (await outputFor(bundle, server)).files.get(pathname);
        if (file) return methodResponse(file, method);
      }
    }
    return null;
  }

  async function start(path) {
    const bundle = create(path);
    const server = Bun.serve({ routes: { "/*": bundle } });
    try { await outputFor(bundle, server); }
    catch (error) { await server.stop(true); throw error; }
    console.log(`Started development server: ${server.url.href}`);
    return server;
  }

  function routeBundles(routes) {
    return routes.flatMap((route) => {
      if (isBundle(route.handler)) return [route.handler];
      return route.handler && typeof route.handler === "object" ? Object.values(route.handler).filter(isBundle) : [];
    });
  }

  function developmentEnabled(development) {
    return development !== false && development?.hmr !== false && (development !== undefined || process.env.NODE_ENV !== "production");
  }

  function response(bytes, type) {
    return new Response(bytes, { headers: {
      "content-type": type, "content-length": String(bytes.length), "cache-control": "no-cache",
    } });
  }

  function applyResult(state, result) {
    state.result = result;
    state.output = {
      html: response(result.html, "text/html;charset=utf-8"),
      files: new Map(result.files.map((file) => [new URL(file.path, "http://localhost/").pathname, response(file.contents, file.type)])),
    };
    for (const path of result.watch) {
      if (!state.snapshots.has(path)) state.snapshots.set(path, snapshot(path));
    }
    if (result.logs) console.error(result.logs);
  }

  function snapshot(path) {
    try { return internal.native.readFile(path); }
    catch { return null; }
  }

  function equalBytes(a, b) {
    if (a === null || b === null) return a === b;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  function broadcast(state, bytes, topic) {
    if (!bytes.length) return;
    for (const socket of state.sockets) if (socket.data.topics.includes(topic)) socket.send(bytes);
  }

  function poll(state) {
    const changed = [];
    for (const [path, old] of state.snapshots) {
      const next = snapshot(path);
      if (equalBytes(old, next)) continue;
      state.snapshots.set(path, next);
      changed.push(path);
    }
    if (!changed.length) return;
    try {
      const result = internal.native.devServerRebuild(state.result.id, JSON.stringify(changed));
      applyResult(state, result);
      broadcast(state, result.errors, "e");
      broadcast(state, result.update, "h");
    } catch (error) { internal.printError(error); }
  }

  function devState(bundle, server) {
    const context = servers.get(server);
    if (!context?.enabled) return null;
    if (context.states.has(bundle)) return context.states.get(bundle);
    const state = { result: null, output: null, snapshots: new Map(), sockets: new Set(), timer: null };
    applyResult(state, internal.native.devServerOpen(bundle.index));
    state.timer = setInterval(() => poll(state), 100).unref();
    context.states.set(bundle, state);
    return state;
  }

  function outputFor(bundle, server) {
    return devState(bundle, server)?.output || compile(bundle);
  }

  function attach(server, routes, development) {
    servers.set(server, { enabled: developmentEnabled(development), bundles: routeBundles(routes), states: new Map() });
  }

  function dispose(server) {
    const context = servers.get(server);
    if (!context) return;
    for (const state of context.states.values()) {
      clearInterval(state.timer);
      internal.native.devServerClose(state.result.id);
      for (const socket of state.sockets) socket.close();
    }
    servers.delete(server);
  }

  // DevServer.rs::is_allowed_dev_origin: browser handshakes must come from
  // the requested host or a localhost name. CLI clients may omit Origin.
  function allowedOrigin(request) {
    const value = request.headers.get("origin");
    if (value === null) return true;
    try {
      const hostname = new URL(value).hostname;
      return hostname === "localhost" || hostname.endsWith(".localhost") || hostname === new URL(request.url).hostname;
    } catch { return false; }
  }

  function upgrade(request, server) {
    const context = servers.get(server);
    if (!context?.enabled || !context.bundles.length || new URL(request.url).pathname !== "/_bun/hmr") return false;
    if (!allowedOrigin(request)) return false;
    const state = devState(context.bundles[0], server);
    return server.upgrade(request, { data: { [hmr]: state, topics: "" } });
  }

  function hmrMessage(socket, message) {
    const state = socket.data[hmr];
    const text = typeof message === "string" ? message : new TextDecoder().decode(message);
    if (text[0] === "s") {
      socket.data.topics = text.slice(1);
      if (text.includes("e") && state.result.errors.length) socket.send(state.result.errors);
      return;
    }
    if (text[0] === "n" && text[1] === "/") socket.send(new Uint8Array([110, 0, 0, 0, 0]));
  }

  function websocket(routes, development, handlers) {
    if (!developmentEnabled(development) || !routeBundles(routes).length) return handlers;
    const wrapped = Object.assign({}, handlers);
    for (const name of ["open", "message", "close", "error", "ping", "pong", "drain"]) {
      wrapped[name] = (socket, ...args) => {
        const state = socket.data?.[hmr];
        if (!state) return handlers?.[name]?.(socket, ...args);
        if (name === "open") {
          state.sockets.add(socket);
          socket.send(encoder.encode("V" + state.result.version));
        }
        if (name === "message") hmrMessage(socket, args[0]);
        if (name === "close") state.sockets.delete(socket);
      };
    }
    return wrapped;
  }

  return { create, isBundle, compile, respond, asset, start, attach, dispose, upgrade, websocket, developmentEnabled };
})
