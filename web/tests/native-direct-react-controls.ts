export async function checkNativeReactDirectStreams(sources: Record<string, string>) {
  const load = new Function("sources", `
    const cache = new Map();
    function require(name) {
      if (cache.has(name)) return cache.get(name).exports;
      const module = { exports: {} };
      cache.set(name, module);
      new Function("require", "module", "exports", sources[name])(require, module, module.exports);
      return module.exports;
    }
    return { React: require("react"), server: require("server") };
  `);
  const { React, server } = load(sources);
  const Original = globalThis.ReadableStream;
  const watermarks: unknown[] = [];
  const pressures: Promise<unknown>[] = [];
  let cancellations = 0;
  function observeSink(sink: object) {
    function get(_target: object, key: PropertyKey) {
      const method = Reflect.get(sink, key);
      if (typeof method !== "function") return method;
      return (...args: unknown[]) => {
        const result = Reflect.apply(method, sink, args);
        if (key === "write" && result instanceof Promise) pressures.push(result);
        return result;
      };
    }
    return new Proxy({}, { get });
  }
  function observeSource(source: object) {
    function get(_target: object, key: PropertyKey) {
      const method = Reflect.get(source, key, source);
      if (key === "pull") return (sink: object) => Reflect.apply(method, source, [observeSink(sink)]);
      if (key !== "cancel") return method;
      return (reason: unknown) => { cancellations++; return Reflect.apply(method, source, [reason]); };
    }
    return new Proxy({}, { get });
  }
  const Observed: typeof ReadableStream = new Proxy(Original, { construct(target, args, newTarget) {
    watermarks.push(Object.getOwnPropertyDescriptor(args[1], "highWaterMark")?.value);
    const forwarded = [observeSource(args[0]), args[1]];
    return Reflect.construct(target, forwarded, newTarget === Observed ? target : newTarget);
  } });
  globalThis.ReadableStream = Observed;
  const rows: { name: string; pass: boolean; error?: string; bytes?: number }[] = [];
  function check(value: unknown, message: string) { if (!value) throw new Error(message); }
  async function collect(stream: ReadableStream<Uint8Array>) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let html = "";
    for (;;) {
      const next = await reader.read();
      if (next.done) return html + decoder.decode();
      check(next.value instanceof Uint8Array, "React emits byte chunks");
      html += decoder.decode(next.value, { stream: true });
    }
  }
  async function render(element: unknown): Promise<ReadableStream<Uint8Array>> {
    return server.renderToReadableStream(element, { onError() {} });
  }
  async function run(name: string, body: () => Promise<number | void>) {
    const timeout = new Error("React direct stream did not settle within 2s");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bound = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(timeout), 2000); });
    try { const bytes = await Promise.race([body(), bound]); rows.push({ name, pass: true, bytes: bytes ?? undefined }); }
    catch (error) { rows.push({ name, pass: false, error: String(error) }); }
    finally { clearTimeout(timer); }
  }
  try {
  await run("react-19.1.1-bun-unicode", async () => {
    const html = await collect(await render(React.createElement("p", null, "hé🙂")));
    check(html === "<p>hé🙂</p>", "Exact Unicode HTML");
    check(new TextEncoder().encode(html).length === 14, "14 UTF-8 bytes");
    return 14;
  });
  await run("react-19.1.1-bun-hwm2048", async () => {
    const text = "é🙂".repeat(3000);
    const html = await collect(await render(React.createElement("p", null, text)));
    check(html === "<p>" + text + "</p>", "Exact HTML above byte HWM");
    check(pressures.length > 1, "React receives pressure promises above 2048 bytes");
    check(new Set(pressures).size === 1, "Pressured writes share one promise");
    check(await pressures[0] === 18004, "Native pressured-byte settlement");
    return new TextEncoder().encode(html).length;
  });
  await run("react-19.1.1-bun-suspense", async () => {
    const deferred = Promise.withResolvers<object>();
    const Lazy = React.lazy(() => deferred.promise);
    const element = React.createElement("html", null, React.createElement("body", null, React.createElement(React.Suspense, { fallback: "loading-marker" }, React.createElement(Lazy))));
    const stream = await render(element);
    const reader = stream.getReader();
    const first = await reader.read();
    check(new TextDecoder().decode(first.value).includes("loading-marker"), "Fallback arrives before resolution");
    deferred.resolve({ default: () => React.createElement("b", null, "resolved-marker") });
    reader.releaseLock();
    const rest = await collect(stream);
    check(rest.includes("resolved-marker"), "Resolved content follows fallback");
  });
  await run("react-19.1.1-bun-cancel-suspense", async () => {
    const Pending = React.lazy(() => new Promise(() => {}));
    const element = React.createElement("html", null, React.createElement("body", null, React.createElement(React.Suspense, { fallback: "waiting" }, React.createElement(Pending))));
    const stream = await render(element);
    const reader = stream.getReader();
    check(!(await reader.read()).done, "Fallback before cancellation");
    await reader.cancel({ exact: "React cancellation" });
    check((await reader.read()).done, "Cancelled reader closes");
    check(cancellations === 1, "React source cancel invoked exactly once");
  });
  check(watermarks.length === 4 && watermarks.every(value => value === 2048), "Every exact React source uses HWM2048");
  } finally { globalThis.ReadableStream = Original; }
  return rows;
}
