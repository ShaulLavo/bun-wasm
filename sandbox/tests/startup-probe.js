(() => {
  if (window.top !== window) return;
  const params = new URLSearchParams(location.search);
  const run = params.get("profile") ?? `${Date.now()}-${params.get("engine") ?? "browser"}`;
  const events = [];
  const errors = [];
  const nativeFetch = window.fetch.bind(window);
  const now = () => performance.now();
  const record = (name, started, detail = {}) => events.push({ name, startTime: started, duration: now() - started, detail });
  const stamp = (name, detail = {}) => events.push({ name, startTime: now(), duration: 0, detail });
  let complete = false;
  let rendering = false;
  let navToRender = null;
  let stdout = "";
  let depsRecorded = false;
  const guestMarkers = new Set();
  let frameResources = [];
  let frameNavigation = [];
  const registrations = new Map();
  let reloadScheduled = false;
  let playgroundStarted = false;
  let playgroundExit = null;

  function activationStarted(worker) {
    return ["activating", "activated", "redundant"].includes(worker.state);
  }

  if (navigator.serviceWorker) {
    const register = ServiceWorkerContainer.prototype.register;
    ServiceWorkerContainer.prototype.register = async function (...args) {
      const started = now();
      const registration = await register.apply(this, args);
      const worker = registration.installing ?? registration.waiting ?? registration.active;
      if (params.has("activationRace") && worker && !activationStarted(worker)) await new Promise((resolve) => worker.addEventListener("statechange", () => activationStarted(worker) && resolve()));
      registrations.set(registration.scope, registration);
      record("service-worker-register", started, { scope: registration.scope, returnedState: worker?.state });
      worker?.addEventListener("statechange", () => stamp("service-worker-state", { scope: registration.scope, state: worker.state }));
      return registration;
    };
  }

  function resources(scope) {
    return scope.performance.getEntriesByType("resource").map((entry) => ({
      name: entry.name, startTime: entry.startTime, duration: entry.duration,
      responseStart: entry.responseStart, responseEnd: entry.responseEnd,
      transferSize: entry.transferSize, encodedBodySize: entry.encodedBodySize,
      decodedBodySize: entry.decodedBodySize, initiatorType: entry.initiatorType,
    }));
  }

  function snapshot() {
    return {
      run, url: location.href, engine: params.get("engine") ?? "browser",
      userAgent: navigator.userAgent, timeOrigin: performance.timeOrigin,
      elapsed: now(), complete, navToRender, playgroundExit, events, errors, stdout,
      status: document.querySelector("#status")?.textContent ?? "",
      server: document.querySelector("#preview-url")?.textContent ?? "",
      phases: performance.getEntries().filter((entry) => entry.name.startsWith("bunwasm:")).map((entry) => ({
        name: entry.name, entryType: entry.entryType, startTime: entry.startTime,
        duration: entry.duration, detail: entry.detail,
      })),
      navigation: performance.getEntriesByType("navigation").map((entry) => entry.toJSON()),
      resources: resources(window), frameResources, frameNavigation,
      notes: ["decompression-pipeline includes time waiting for incoming network bytes", "render detection waits for the counter DOM and two animation frames"],
    };
  }

  async function upload() {
    if (params.get("profileUpload") === "0") return;
    try {
      const response = await nativeFetch(`/__profile?run=${encodeURIComponent(run)}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(snapshot()),
      });
      if (response.ok && complete) scheduleReload();
    } catch {}
  }

  function scheduleReload() {
    const next = params.get("reloadProfile");
    if (!next || reloadScheduled) return;
    reloadScheduled = true;
    setTimeout(() => {
      const url = new URL(location.href);
      url.searchParams.set("profile", next);
      url.searchParams.delete("reloadProfile");
      location.replace(url.href);
    }, 500);
  }

  function finish(name) {
    navToRender = now();
    stamp(name);
    complete = true;
    clearInterval(poll);
    clearInterval(uploads);
    setTimeout(upload, 250);
  }

  function terminalText(term) {
    const buffer = term.buffer.active;
    const lines = [];
    for (let index = 0; index < buffer.length; index++) {
      const line = buffer.getLine(index);
      const text = line?.translateToString(true) ?? "";
      if (line?.isWrapped && lines.length) lines[lines.length - 1] += text;
      else lines.push(text);
    }
    return lines.join("\n").trimEnd();
  }

  async function runPlayground() {
    const ui = globalThis.playground;
    if (playgroundStarted || !ui || !document.querySelector("#status")?.textContent?.startsWith("bun.wasm ready")) return;
    playgroundStarted = true;
    try {
      await ui.fs.writeFile("/home/user/ios-first-visit-a.ts", 'import { b } from "./ios-first-visit-b";\nexport function a(): string { return "IOS first visit ok"; }\nconsole.log(b());\n');
      await ui.fs.writeFile("/home/user/ios-first-visit-b.ts", 'import { a } from "./ios-first-visit-a";\nexport function b(): string { return a(); }\nconsole.log("cycle peer:", a());\n');
      await ui.shell.submit("bun run ios-first-visit-a.ts");
      await new Promise((resolve) => ui.term.write("", resolve));
      stdout = terminalText(ui.term);
      playgroundExit = ui.shell.lastExit;
      if (playgroundExit !== 0 || !stdout.includes("IOS first visit ok")) throw new Error(`Playground cyclic imports failed, exit ${playgroundExit}`);
      finish("playground-completed");
    } catch (error) {
      errors.push({ at: now(), type: "playground", message: String(error) });
      void upload();
    }
  }

  window.__startupProfile = { snapshot };
  window.fetch = async (...args) => {
    const started = now();
    const url = String(args[0] instanceof Request ? args[0].url : args[0]);
    try {
      const response = await nativeFetch(...args);
      record("fetch-headers", started, { url, status: response.status });
      return response;
    } catch (error) {
      record("fetch-error", started, { url, error: String(error) });
      throw error;
    }
  };

  for (const method of ["compile", "compileStreaming"]) {
    const original = WebAssembly[method].bind(WebAssembly);
    WebAssembly[method] = async (...args) => {
      const started = now();
      try { return await original(...args); }
      finally { record(`wasm-${method}`, started); }
    };
  }

  const decompressors = new WeakSet();
  const NativeDecompressionStream = window.DecompressionStream;
  window.DecompressionStream = class extends NativeDecompressionStream {
    constructor(...args) { super(...args); decompressors.add(this); }
  };
  const pipeThrough = ReadableStream.prototype.pipeThrough;
  ReadableStream.prototype.pipeThrough = function (transform, ...args) {
    const result = pipeThrough.call(this, transform, ...args);
    if (!decompressors.has(transform)) return result;
    const started = now();
    return pipeThrough.call(result, new TransformStream({
      transform(chunk, controller) { controller.enqueue(chunk); },
      flush() { record("decompression-pipeline", started); },
    }));
  };

  function receiveWorker(event, started, url, first) {
    const message = event.data;
    if (first()) record("worker-first-message", started, { url, type: message?.type });
    if (message?.type === "net" && message.req?.type === "listen") stamp("dev-server-listening", { port: message.req.port });
    if (message?.type !== "stdout" && message?.type !== "stderr") return;
    const text = new TextDecoder().decode(message.data);
    stdout += text;
    for (const marker of stdout.matchAll(/\[profile\] ([\w-]+)(?: (\d+))?\r?\n/g)) {
      if (guestMarkers.has(marker[1])) continue;
      guestMarkers.add(marker[1]);
      events.push({ name: marker[1], startTime: marker[2] ? Number(marker[2]) - performance.timeOrigin : now(), duration: 0, detail: { source: "guest stdout", receivedAt: now(), timestamped: Boolean(marker[2]) } });
    }
    const match = /deps:.*?in (\d+) ms/.exec(stdout);
    if (!match || depsRecorded) return;
    depsRecorded = true;
    events.push({ name: "bundle-deps", startTime: now() - Number(match[1]), duration: Number(match[1]), detail: { source: "guest stdout", text: match[0] } });
  }

  const NativeWorker = window.Worker;
  window.Worker = class extends NativeWorker {
    constructor(url, options) {
      const started = now();
      super(url, options);
      const href = new URL(url, location.href).href;
      const registration = Array.from(registrations.values()).find((entry) => href.startsWith(entry.scope));
      stamp("worker-created", { url: String(url), scopeState: registration?.active?.state });
      let received = false;
      const first = () => { const value = !received; received = true; return value; };
      this.addEventListener("message", (event) => receiveWorker(event, started, String(url), first));
      this.addEventListener("error", (event) => errors.push({ at: now(), type: "worker", url: String(url), message: event.message ?? "Worker error event has no message" }));
    }
    postMessage(...args) {
      stamp("worker-post", { engine: args[0]?.engine, args: args[0]?.args });
      return super.postMessage(...args);
    }
  };

  window.addEventListener("error", (event) => errors.push({ at: now(), type: "error", message: event.message }));
  window.addEventListener("unhandledrejection", (event) => errors.push({ at: now(), type: "unhandledrejection", message: String(event.reason) }));
  window.addEventListener("message", (event) => {
    if (typeof event.data?.type === "string" && event.data.type.startsWith("bunwasm:")) stamp(event.data.type, event.data);
  });

  function inspectFrame() {
    const frame = document.querySelector("#preview");
    if (!frame?.contentWindow || !frame.contentDocument?.querySelector("button.counter") || rendering) return;
    rendering = true;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const offset = frame.contentWindow.performance.timeOrigin - performance.timeOrigin;
      frameResources = resources(frame.contentWindow).map((entry) => ({ ...entry, navigationStart: offset, topStartTime: offset + entry.startTime }));
      frameNavigation = frame.contentWindow.performance.getEntriesByType("navigation").map((entry) => ({ ...entry.toJSON(), topStartTime: offset }));
      finish("react-rendered");
    }));
  }

  let lastStatus = "";
  const poll = setInterval(() => {
    const status = document.querySelector("#status")?.textContent ?? "";
    if (status !== lastStatus) { stamp("status", { text: status }); lastStatus = status; }
    try { inspectFrame(); } catch {}
    if (params.get("playgroundRun") === "1") void runPlayground();
  }, 25);
  const uploads = setInterval(upload, 1000);
  setTimeout(() => { if (!complete) { stamp("timeout"); clearInterval(poll); clearInterval(uploads); void upload(); } }, 180000);
})();
