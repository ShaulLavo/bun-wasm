// fetch() reads and checks its arguments as Bun does: a plain object first argument is a
// request init with a url, Bun's own options are read (their getters run), bad values and
// throwing getters reject before any request is sent.
let requests = 0;
const server = Bun.listen({
  port: 0,
  hostname: "127.0.0.1",
  socket: {
    open(socket) {
      requests++;
      socket.terminate();
    },
    data(socket) {
      socket.terminate();
    },
  },
});
const url = `http://127.0.0.1:${server.port}/`;

function describe(error: unknown): string {
  if (typeof error !== "object" || error === null) return `${typeof error} ${String(error)}`;
  const e = error as { name?: string; message?: string; code?: unknown };
  return `${e.name}: ${e.message}` + (e.code !== undefined ? ` [${String(e.code)}]` : "");
}

async function run(label: string, factory: () => unknown): Promise<void> {
  const before = requests;
  let outcome: string;
  try {
    const value = factory();
    const kind = value instanceof Promise ? "promise" : "value";
    try {
      const result = await value;
      outcome = `${kind} resolved` + (result instanceof Response ? ` ${JSON.stringify(await result.text())}` : "");
    } catch (error) {
      outcome = `${kind} rejected ${describe(error)}`;
    }
  } catch (error) {
    outcome = `threw synchronously ${describe(error)}`;
  }
  await Bun.sleep(5);
  console.log(`${label}: ${outcome}; requests ${requests - before}`);
}

function throwing(name: string, base: object = {}): any {
  return Object.defineProperty(base, name, {
    enumerable: true,
    get() {
      throw new Error(`${name}-boom`);
    },
  });
}

console.log("fetch.length", fetch.length);
const names = ["body", "decompress", "headers", "keepalive", "method", "proxy", "redirect", "signal", "timeout", "tls", "unix", "verbose"];
for (const name of names) {
  await run(`init ${name} getter`, () => fetch(url, throwing(name)));
  await run(`first-argument ${name} getter`, () => fetch(throwing(name, { url })));
  await run(`Request and init ${name} getter`, () => fetch(new Request(url), throwing(name)));
}

const any = fetch as (...args: unknown[]) => Promise<Response>;
await run("no arguments", () => any());
await run("blank url", () => fetch(""));
await run("invalid url", () => fetch("not a url"));
await run("relative url", () => fetch("/path"));
await run("url toString throws", () => any({ toString() { throw new Error("UBOOM"); } }));
await run("object without url", () => any({}));
await run("object with url toString", () => any({ toString: () => "data:,from-to-string" }));
await run("first-argument data url", () => any({ url: "data:,from-object" }));
await run("data url skips option getters", () => fetch("data:,skipped", throwing("method")));
await run("data url without a comma", () => fetch("data:text/plain"));
await run("data url with invalid base64", () => fetch("data:text/plain;base64,@@@"));
await run("data url with base64", () => fetch("data:text/plain;base64,aGk="));
await run("GET with a body", () => fetch(url, { body: "x" }));
await run("HEAD with a body", () => fetch(url, { method: "HEAD", body: "x" }));
await run("first-argument GET with a body", () => any({ url, body: "x" }));
await run("redirect not an option", () => any(url, { redirect: "sideways" }));
await run("Request and bad redirect", () => any(new Request(url), { redirect: "sideways" }));
await run("proxy with unix", () => fetch(url, { proxy: url, unix: "/tmp/fetch-argument-checks.sock" }));
await run("invalid proxy", () => fetch(url, { proxy: "not a url" }));
await run("invalid proxy.url", () => any(url, { proxy: { url: "not a url" } }));
await run("tls ca number", () => any(url, { tls: { ca: 123 } }));
await run("tls cert number", () => any(url, { tls: { cert: 1 } }));
await run("tls key number", () => any(url, { tls: { key: 1 } }));
await run("tls ca array element", () => any(url, { tls: { ca: ["x", 1] } }));
await run("tls ca and cert both bad", () => any(url, { tls: { cert: 1, ca: 1 } }));
await run("tls rejectUnauthorized number", () => any(url, { tls: { rejectUnauthorized: 0 } }));
await run("tls serverName number", () => any(url, { tls: { serverName: 1 } }));
await run("tls passphrase number", () => any(url, { tls: { passphrase: 1 } }));
await run("maxRedirects negative", () => any(url, { maxRedirects: -1 }));
await run("protocol unknown", () => any(url, { protocol: "h9" }));
await run("compress unknown", () => any(url, { compress: "nope" }));
await run("compress number", () => any(url, { compress: 5 }));
await run("compress encoding unknown", () => any(url, { compress: { encoding: "x" } }));
await run("init signal not a signal", () => any(url, { signal: 1 }));
await run("first-argument signal not a signal", () => any({ url, signal: 1 }));
await run("aborted signal", () => fetch(url, { signal: AbortSignal.abort() }));
await run("aborted signal with a reason", () => fetch(url, { signal: AbortSignal.abort("why") }));
const used = new Request(url, { method: "POST", body: "x" });
await used.text();
await run("Request with a used body", () => fetch(used));
await run("headers iterable throws", () => any(url, { headers: { *[Symbol.iterator]() { throw new Error("HBOOM"); } } }));
console.log("default abort reason:", describe(AbortSignal.abort().reason));
server.stop(true);
