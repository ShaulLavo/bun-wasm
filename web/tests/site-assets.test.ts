import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { brotliCompressSync, brotliDecompressSync, gunzipSync, gzipSync } from "node:zlib";

// Requests go through a real Wrangler. The per-test limit only catches a hang and must outlast the 30 s request cap.
setDefaultTimeout(35_000);
const wasm = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
const brotli = brotliCompressSync(wasm);
const gzip = gzipSync(wasm);
const rawOnly = Buffer.concat([wasm, Buffer.from([0, 0x80, 0x80, 0x08]), Buffer.alloc(128 * 1024)]);
const program = "/programs/base/waffle-coreutils/dist/ls.wasm";
// The bash-web shell guest sits directly under programs/, outside Waffle's base families.
const shell = Buffer.concat([wasm, Buffer.from([0, 0x80, 0x80, 0x04]), Buffer.alloc(64 * 1024, 7)]);
const shellBrotli = brotliCompressSync(shell);
const shellGzip = gzipSync(shell);
const shellPaths = ["/programs/shell-engine.wasm", "/playground/programs/shell-engine.wasm"];
// Bun guests ship only their twins: jsc-engine.wasm is over the 25 MiB asset limit raw.
const guest = Buffer.concat([wasm, Buffer.from([0, 0x80, 0x80, 0x02]), Buffer.alloc(32 * 1024)]);
const guestBrotli = brotliCompressSync(guest);
const guestGzip = gzipSync(guest);
const guestPaths = ["/bun-browser.wasm", "/playground/bun-browser.wasm", "/profiles/shared-group/bun.wasm", "/playground/profiles/shared-group/quickjs.wasm"];
const networkPaths = ["/network.wasm", "/__bunwasm/chunks/network.wasm"];
let root: string;
let origin: string;
let nativeOrigin: string;
let publicOrigin: string;
const stops: (() => Promise<void>)[] = [];
let large: Buffer<ArrayBuffer>;

function hosting(config: string, directory: string, bundle?: string) {
  const node = Bun.which("node");
  if (!node) throw new Error("Local Worker proof requires Node for pinned Wrangler");
  const command = bundle ? [join(import.meta.dir, "fixtures/site-assets-host.ts"), config, bundle]
    : [resolve(import.meta.dir, "../../node_modules/wrangler/bin/wrangler.js"), "dev", "--config", config,
      "--local", "--ip", "127.0.0.1", "--port", "0", "--inspector-port", "0", "--persist-to", join(directory, "state"),
      "--show-interactive-dev-session=false"];
  const child = spawn(node, command, {
    cwd: directory, detached: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", WRANGLER_LOG_PATH: join(directory, basename(config) + ".log"), WRANGLER_REGISTRY_PATH: join(directory, "registry", basename(config)), WRANGLER_SEND_ERROR_REPORTS: "false" },
  });
  let output = "";
  const closed = new Promise<void>(resolve => { child.once("close", () => resolve()); });
  const signal = (value: NodeJS.Signals) => {
    if (!child.pid) return;
    try { process.kill(-child.pid, value); }
    catch (error) { if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error; }
  };
  const close = async () => {
    signal("SIGTERM");
    const force = setTimeout(() => signal("SIGKILL"), 3000);
    try { await closed; } finally { clearTimeout(force); }
  };
  const ready = new Promise<string>((resolve, reject) => {
    const collect = (chunk: Buffer) => {
      output += chunk.toString();
      const url = /Ready on (http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1];
      if (url) resolve(url);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    child.once("error", reject);
    child.once("close", () => reject(new Error(`Wrangler exited before ready: ${output}`)));
  });
  return { ready, close };
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "bun-wasm-public-assets-"));
  const assets = join(root, "assets");
  await Bun.write(join(assets, "index.html"), "<h1>home</h1>");
  await Bun.write(join(assets, "404.html"), "<h1>missing</h1>");
  await Bun.write(join(assets, "playground/index.html"), "<h1>playground</h1>");
  await Bun.write(join(assets, "chunks/chunk-a1.js"), "export const x = 1;");
  await Bun.write(join(assets, "unrelated.wasm"), wasm);
  await Bun.write(join(assets, program.replace("ls.wasm", "raw-only.wasm")), rawOnly);
  await Bun.write(join(assets, "programs/base/readme.txt"), "unencoded static file");
  const payload = randomBytes(1024 * 1024);
  payload[0] = 0;
  large = Buffer.concat([wasm, Buffer.from([0, 0x80, 0x80, 0x40]), payload]);
  expect(WebAssembly.validate(large)).toBe(true);
  await Bun.write(join(assets, program.replace("ls.wasm", "large.wasm")), large);
  await Bun.write(join(assets, program.replace("ls.wasm", "large.wasm.br")), brotliCompressSync(large));
  await Bun.write(join(assets, "/playground" + program), wasm);
  await Bun.write(join(assets, "/playground" + program + ".br"), brotli);
  for (const path of shellPaths) {
    await Bun.write(join(assets, path), shell);
    await Bun.write(join(assets, path + ".br"), shellBrotli);
    await Bun.write(join(assets, path + ".gz"), shellGzip);
  }
  await Bun.write(join(assets, program), wasm);
  await Bun.write(join(assets, program + ".br"), brotli);
  await Bun.write(join(assets, program + ".gz"), gzip);
  for (const path of guestPaths) {
    await Bun.write(join(assets, path + ".br"), guestBrotli);
    await Bun.write(join(assets, path + ".gz"), guestGzip);
  }
  // Waffle's network.wasm stays on native routing, so even a stray twin beside it is never selected.
  for (const path of networkPaths) {
    await Bun.write(join(assets, path), wasm);
    await Bun.write(join(assets, path + ".br"), "not the network module");
  }
  await Bun.write(join(assets, "_headers"), await Bun.file(join(import.meta.dir, "../_headers")).text()
    + `\n${program}\n  Cache-Control: public, max-age=60\n  Vary: Origin\n  X-Logical-Asset: preserved\n${program}.br\n  Cache-Control: no-store\n  X-Sidecar-Only: not-logical\n`);
  const original = await Bun.file(join(import.meta.dir, "../../site/wrangler.jsonc")).text();
  const config = join(root, "wrangler.jsonc");
  await Bun.write(config, original.replace('"./dist"', JSON.stringify(assets)).replace('"worker.ts"', JSON.stringify(resolve(import.meta.dir, "../../site/worker.ts"))));
  const server = hosting(config, root);
  stops.push(server.close);
  const timeout = setTimeout(() => { void server.close(); }, 60000);
  try { publicOrigin = await server.ready; } finally { clearTimeout(timeout); }
  const nativeConfig = join(root, "native.jsonc");
  const native = (await Bun.file(config).text()).replace(/^.*"main":.*\n/m, "").replace(/^.*"binding":.*\n/m, "").replace(/^.*"run_worker_first":.*\n/m, "");
  await Bun.write(nativeConfig, native);
  const baseline = hosting(nativeConfig, root);
  stops.push(baseline.close);
  const nativeTimeout = setTimeout(() => { void baseline.close(); }, 60000);
  try { nativeOrigin = await baseline.ready; } finally { clearTimeout(nativeTimeout); }
  const build = await Bun.build({ entrypoints: [resolve(import.meta.dir, "../../site/worker.ts")], target: "browser", format: "esm", outdir: join(root, "bundle") });
  if (!build.success || !build.outputs[0]) throw new Error(`Worker fixture bundle failed: ${build.logs.join("\n")}`);
  const direct = hosting(config, root, build.outputs[0].path);
  stops.push(direct.close);
  const directTimeout = setTimeout(() => { void direct.close(); }, 60000);
  try { origin = await direct.ready; } finally { clearTimeout(directTimeout); }
}, 200000); // three Wrangler starts; the limits only catch a hang, a busy machine starts them slowly

afterAll(async () => {
  for (const stop of stops.reverse()) await stop();
  if (root) await rm(root, { recursive: true, force: true });
});

function get(path: string, encoding: string | undefined, options: { method?: string; headers?: Record<string, string>; origin?: string } = {}) {
  return new Promise<{ status: number; headers: import("node:http").IncomingHttpHeaders; body: Buffer; chunks: number }>((resolve, reject) => {
    const headers: Record<string, string> = { ...options.headers };
    if (encoding !== undefined) headers["accept-encoding"] = encoding;
    const req = request(new URL(path, options.origin ?? origin), { method: options.method ?? "GET", headers }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks), chunks: chunks.length }));
    });
    req.on("error", reject);
    // Hang cap only: a busy machine can take several seconds to answer through Wrangler.
    req.setTimeout(30_000, () => req.destroy(new Error("Worker request timed out")));
    req.end();
  });
}

test("public hosting selects the supplied Brotli sidecar at the logical program URL", async () => {
  const response = await get(program, "br, gzip", { origin: publicOrigin });
  expect(response.status).toBe(200);
  expect(response.headers["content-encoding"]).toBe("br");
  expect(response.headers["content-type"]).toBe("application/wasm");
  expect(response.body).toEqual(brotli);
});


const preferences: [string | undefined, string | undefined][] = [
  [undefined, undefined], ["", undefined], ["br;q=0, gzip", "gzip"],
  ["br;q=0,gzip;q=0", undefined], ["gzip;q=0.8,br;q=0.2", "gzip"],
  ["*", "br"], ["br;q=0,*;q=0.5", "gzip"], ["*;q=0,br;q=0.5", "br"],
  ["*;q=0,identity;q=1", undefined], ["identity;q=0.8,br;q=0.2", undefined],
  ["BR;Q=1.000,gzip;q=0", "br"], ["deflate", undefined], ["x-gzip", "gzip"],
  ["br;q=0,br;q=1,gzip;q=0", undefined],
];

test.each(preferences)("Worker negotiates %s and sends the selected bytes unchanged", async (accept, expected) => {
  const response = await get(program, accept);
  expect(response.status).toBe(200);
  expect(response.headers["content-encoding"]).toBe(expected);
  expect(response.headers["content-type"]).toBe("application/wasm");
  if (response.headers["content-length"] !== undefined) expect(response.headers["content-length"]).toBe(String(response.body.length));
  expect(response.headers["cache-control"]).toBe(expected ? "public, max-age=60, no-transform" : "public, max-age=60");
  expect(response.headers["vary"]?.toLowerCase()).toContain("origin");
  expect(response.headers["vary"]?.toLowerCase()).toContain("accept-encoding");
  expect(response.headers["cross-origin-opener-policy"]).toBe("same-origin");
  expect(response.headers["cross-origin-embedder-policy"]).toBe("require-corp");
  expect(response.headers["cross-origin-resource-policy"]).toBe("same-origin");
  expect(response.headers["x-logical-asset"]).toBe("preserved");
  expect(response.headers["x-sidecar-only"]).toBeUndefined();
  expect(response.body).toEqual(expected === "br" ? brotli : expected === "gzip" ? gzip : wasm);
  expect(expected === "br" ? brotliDecompressSync(response.body) : expected === "gzip" ? gunzipSync(response.body) : response.body).toEqual(wasm);
});

test.each(["*;q=0", "br;q=0,gzip;q=0,identity;q=0", "identity;q=0,deflate"])("Worker refuses an unacceptable representation for %s", async accept => {
  const response = await get(program, accept);
  expect(response.status).toBe(406);
  expect(response.body.length).toBe(0);
  expect(response.headers["content-encoding"]).toBeUndefined();
  expect(response.headers["vary"]?.toLowerCase()).toContain("accept-encoding");
  expect(response.headers["cross-origin-embedder-policy"]).toBe("require-corp");
});

test.each(["br;q=2", "gzip;q=-1", "br;q=0.1234", "gzip;q=.5", "br;q=no"])("Worker rejects malformed weights at the request boundary: %s", async accept => {
  const response = await get(program, accept);
  expect(response.status).toBe(400);
  expect(response.body.length).toBe(0);
  expect(response.headers["content-encoding"]).toBeUndefined();
  expect(response.headers["cross-origin-embedder-policy"]).toBe("require-corp");
});

test("Worker handles nested playground URLs and queries without changing logical paths", async () => {
  const response = await get("/playground" + program + "?cache=fixture", "br");
  expect(response.status).toBe(200);
  expect(response.headers["content-encoding"]).toBe("br");
  expect(response.body).toEqual(brotli);
});

const shellCases = shellPaths.flatMap(path => ([["br, gzip, identity", "br"], ["gzip, identity", "gzip"], ["identity", undefined]] as const).map(([accept, expected]) => [path, accept, expected] as const));

test.each(shellCases)("Worker sends the precompressed shell guest at %s for %s", async (path, accept, expected) => {
  const response = await get(path, accept);
  expect(response.status).toBe(200);
  expect(response.headers["content-encoding"]).toBe(expected);
  expect(response.headers["content-type"]).toBe("application/wasm");
  expect(response.headers["vary"]?.toLowerCase()).toContain("accept-encoding");
  expect(response.headers["cache-control"]?.includes("no-transform")).toBe(expected !== undefined);
  expect(response.headers["cross-origin-embedder-policy"]).toBe("require-corp");
  expect(response.body).toEqual(expected === "br" ? shellBrotli : expected === "gzip" ? shellGzip : shell);
});

test.each(shellPaths)("Worker keeps HEAD, Range and refusal semantics for the shell guest at %s", async path => {
  const head = await get(path, "br", { method: "HEAD" });
  expect(head.status).toBe(200);
  expect(head.body.length).toBe(0);
  expect(head.headers["content-encoding"]).toBe("br");
  if (head.headers["content-length"] !== undefined) expect(head.headers["content-length"]).toBe(String(shellBrotli.length));
  const range = await get(path, "br", { headers: { range: "bytes=0-3" } });
  const native = await get(path + ".br", "identity", { origin: nativeOrigin, headers: { range: "bytes=0-3" } });
  expect(range.status).toBe(native.status);
  expect(range.headers["content-range"]).toBe(native.headers["content-range"]);
  expect(range.headers["content-encoding"]).toBe("br");
  expect(range.body).toEqual(native.body);
  const refused = await get(path, "br;q=0, gzip;q=0, identity;q=0");
  expect(refused.status).toBe(406);
  expect(refused.body.length).toBe(0);
  expect(refused.headers["vary"]?.toLowerCase()).toContain("accept-encoding");
});

const guestCases = guestPaths.flatMap(path => (["worker", "public"] as const).flatMap(host => ([["br, gzip", "br"], ["gzip, deflate", "gzip"], ["br;q=0, gzip", "gzip"]] as const)
  .map(([accept, expected]) => [path, host, accept, expected] as const)));

test.each(guestCases)("a twin-only Bun guest at %s through the %s host answers %s with its precompressed twin", async (path, host, accept, expected) => {
  const response = await get(`${path}?v=fixture-build`, accept, { origin: host === "public" ? publicOrigin : origin });
  expect(response.status).toBe(200);
  expect(response.headers["content-encoding"]).toBe(expected);
  expect(response.headers["content-type"]).toBe("application/wasm");
  expect(response.headers["vary"]?.toLowerCase()).toContain("accept-encoding");
  expect(response.headers["cache-control"]).toContain("no-transform");
  expect(response.headers["cross-origin-embedder-policy"]).toBe("require-corp");
  expect(response.headers["cross-origin-resource-policy"]).toBe("same-origin");
  if (response.headers["content-length"] !== undefined) expect(response.headers["content-length"]).toBe(String(response.body.length));
  expect(response.body).toEqual(expected === "br" ? guestBrotli : guestGzip);
  expect(expected === "br" ? brotliDecompressSync(response.body) : gunzipSync(response.body)).toEqual(guest);
});

test.each(guestPaths)("a twin-only Bun guest at %s keeps HEAD, Range, validator and refusal semantics", async path => {
  const head = await get(path, "br", { method: "HEAD" });
  expect(head.status).toBe(200);
  expect(head.body.length).toBe(0);
  expect(head.headers["content-encoding"]).toBe("br");
  expect(head.headers["content-type"]).toBe("application/wasm");
  if (head.headers["content-length"] !== undefined) expect(head.headers["content-length"]).toBe(String(guestBrotli.length));
  const range = await get(path, "gzip", { headers: { range: "bytes=0-3" } });
  const native = await get(path + ".gz", "identity", { origin: nativeOrigin, headers: { range: "bytes=0-3" } });
  expect(range.status).toBe(native.status);
  expect(range.headers["content-range"]).toBe(native.headers["content-range"]);
  expect(range.headers["content-encoding"]).toBe("gzip");
  expect(range.body).toEqual(native.body);
  const encoded = await get(path, "br");
  expect(encoded.headers["etag"]).toBeString();
  const revalidated = await get(path, "br", { headers: { "if-none-match": String(encoded.headers["etag"]) } });
  expect(revalidated.status).toBe(304);
  expect(revalidated.headers["vary"]?.toLowerCase()).toContain("accept-encoding");
  // No raw file ships, so a client that accepts only identity is refused rather than sent encoded bytes.
  for (const accept of ["identity", "br;q=0, gzip;q=0"]) {
    const refused = await get(path, accept);
    expect(refused.status).toBe(406);
    expect(refused.body.length).toBe(0);
    expect(refused.headers["content-encoding"]).toBeUndefined();
    expect(refused.headers["vary"]?.toLowerCase()).toContain("accept-encoding");
    expect(refused.headers["cross-origin-embedder-policy"]).toBe("require-corp");
  }
  expect((await get(path, "br;q=2")).status).toBe(400);
});

test.each(["/bun-jsc.wasm", "/playground/jsc-engine.wasm"])("a guest with no representation at %s keeps the native missing response", async path => {
  const [worker, publicHost, native] = await Promise.all([get(path, "identity"), get(path, "identity", { origin: publicOrigin }), get(path, "identity", { origin: nativeOrigin })]);
  for (const response of [worker, publicHost]) {
    expect(response.status).toBe(native.status);
    expect(response.body).toEqual(native.body);
    expect(response.headers["content-type"]).toBe(native.headers["content-type"]);
    expect((await get(path, "br, gzip", { origin: response === worker ? origin : publicOrigin })).status).toBe(native.status);
  }
});

test.each(networkPaths)("public routing leaves Waffle's %s on native asset handling", async path => {
  const [publicHost, native] = await Promise.all([get(path, "br, gzip", { origin: publicOrigin }), get(path, "br, gzip", { origin: nativeOrigin })]);
  expect(publicHost.status).toBe(200);
  expect(publicHost.headers["content-encoding"]).toBe(native.headers["content-encoding"]);
  expect(publicHost.headers["vary"]).toBe(native.headers["vary"]);
  expect(publicHost.body).toEqual(native.body);
});

test.each(["br,gzip", "br;q=0,gzip"])("raw-only programs retain native compression for %s", async accept => {
  const raw = program.replace("ls.wasm", "raw-only.wasm");
  expect(WebAssembly.validate(rawOnly)).toBe(true);
  const direct = await get(raw, accept);
  expect(direct.status).toBe(200);
  expect(direct.body).toEqual(rawOnly);
  expect(direct.headers["cache-control"]).not.toContain("no-transform");
  expect(direct.headers["vary"]?.toLowerCase()).toContain("accept-encoding");
  const native = await get(raw, accept, { origin: nativeOrigin });
  const worker = await get(raw, accept, { origin: publicOrigin });
  expect(worker.status).toBe(native.status);
  expect(worker.headers["content-encoding"]).toBe(native.headers["content-encoding"]);
  expect(worker.headers["content-encoding"]).toBe(accept.startsWith("br;q=0") ? "gzip" : "br");
  expect(worker.body).toEqual(native.body);
  expect(worker.body.length).toBeLessThan(rawOnly.length / 2);
  const decoded = worker.headers["content-encoding"] === "br" ? brotliDecompressSync(worker.body) : gunzipSync(worker.body);
  expect(decoded).toEqual(rawOnly);
});

test("raw-only programs preserve identity requests and refusals", async () => {
  const raw = program.replace("ls.wasm", "raw-only.wasm");
  const identity = await get(raw, "identity", { origin: publicOrigin });
  expect(identity.headers["content-encoding"]).toBeUndefined();
  expect(identity.body).toEqual(rawOnly);
  expect((await get(raw, "br,gzip,identity;q=0")).status).toBe(406);
  expect((await get(raw, "*;q=0")).status).toBe(406);
});

test("Worker preserves HEAD and native asset range behavior", async () => {
  const head = await get(program, "br", { method: "HEAD" });
  expect(head.status).toBe(200);
  expect(head.body.length).toBe(0);
  expect(head.headers["content-encoding"]).toBe("br");
  if (head.headers["content-length"] !== undefined) expect(head.headers["content-length"]).toBe(String(brotli.length));
  const range = await get(program, "br", { headers: { range: "bytes=0-3" } });
  const native = await get(program + ".br", "identity", { origin: nativeOrigin, headers: { range: "bytes=0-3" } });
  expect(range.status).toBe(native.status);
  expect(range.headers["content-range"]).toBe(native.headers["content-range"]);
  expect(range.headers["content-encoding"]).toBe("br");
  expect(range.body).toEqual(native.body);
});

test("Worker validators identify the selected representation, not the raw file", async () => {
  const encoded = await get(program, "br");
  const raw = await get(program, "identity");
  expect(encoded.headers["etag"]).toBeString();
  expect(encoded.headers["etag"]).not.toBe(raw.headers["etag"]);
  const response = await get(program, "br", { headers: { "if-none-match": String(encoded.headers["etag"]) } });
  expect(response.status).toBe(304);
  expect(response.body.length).toBe(0);
  expect(response.headers["vary"]?.toLowerCase()).toContain("accept-encoding");
  expect(response.headers["etag"]).toBe(encoded.headers["etag"]);
});

test.each(["/", "/index.html", "/playground/", "/playground/index.html", "/chunks/chunk-a1.js", "/unrelated.wasm", "/programs/base/readme.txt", "/missing", program.replace("ls.wasm", "missing.wasm")])("keeps native static behavior for %s", async path => {
  const [worker, native] = await Promise.all([get(path, "identity"), get(path, "identity", { origin: nativeOrigin })]);
  expect(worker.status).toBe(native.status);
  expect(worker.body).toEqual(native.body);
  for (const field of ["content-type", "cache-control", "cross-origin-opener-policy", "cross-origin-embedder-policy", "cross-origin-resource-policy", "etag"]) expect(worker.headers[field]).toBe(native.headers[field]);
  const workerLocation = worker.headers["location"];
  const nativeLocation = native.headers["location"];
  expect(workerLocation ? new URL(workerLocation, origin).pathname : undefined).toBe(nativeLocation ? new URL(nativeLocation, nativeOrigin).pathname : undefined);
});

test("Worker streams the supplied larger representation instead of double-compressing it", async () => {
  const response = await get(program.replace("ls.wasm", "large.wasm"), "br");
  expect(response.status).toBe(200);
  expect(response.chunks).toBeGreaterThan(1);
  expect(response.body).toEqual(brotliCompressSync(large));
  expect(brotliDecompressSync(response.body)).toEqual(large);
});

test("Wrangler ingress uses original client weights after Cloudflare header normalization", async () => {
  const response = await get(program, "br;q=0, gzip", { origin: publicOrigin });
  expect(response.status).toBe(200);
  expect(response.headers["content-encoding"]).toBe("gzip");
  expect(response.body).toEqual(gzip);
  const identity = await get(program, "identity", { origin: publicOrigin });
  expect(identity.headers["content-encoding"]).toBeUndefined();
  expect(identity.body).toEqual(wasm);
});
