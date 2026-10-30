import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { brotliCompressSync, brotliDecompressSync, gunzipSync, gzipSync } from "node:zlib";

const wasm = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
const brotli = brotliCompressSync(wasm);
const gzip = gzipSync(wasm);
const program = "/programs/base/waffle-coreutils/dist/ls.wasm";
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
  await Bun.write(join(assets, program.replace("ls.wasm", "raw-only.wasm")), wasm);
  await Bun.write(join(assets, "programs/base/readme.txt"), "unencoded static file");
  const payload = randomBytes(1024 * 1024);
  payload[0] = 0;
  large = Buffer.concat([wasm, Buffer.from([0, 0x80, 0x80, 0x40]), payload]);
  expect(WebAssembly.validate(large)).toBe(true);
  await Bun.write(join(assets, program.replace("ls.wasm", "large.wasm")), large);
  await Bun.write(join(assets, program.replace("ls.wasm", "large.wasm.br")), brotliCompressSync(large));
  await Bun.write(join(assets, "/playground" + program), wasm);
  await Bun.write(join(assets, "/playground" + program + ".br"), brotli);
  await Bun.write(join(assets, program), wasm);
  await Bun.write(join(assets, program + ".br"), brotli);
  await Bun.write(join(assets, program + ".gz"), gzip);
  await Bun.write(join(assets, "_headers"), await Bun.file(join(import.meta.dir, "../_headers")).text()
    + `\n${program}\n  Cache-Control: public, max-age=60\n  Vary: Origin\n  X-Logical-Asset: preserved\n${program}.br\n  Cache-Control: no-store\n  X-Sidecar-Only: not-logical\n`);
  const original = await Bun.file(join(import.meta.dir, "../../site/wrangler.jsonc")).text();
  const config = join(root, "wrangler.jsonc");
  await Bun.write(config, original.replace('"./dist"', JSON.stringify(assets)).replace('"worker.ts"', JSON.stringify(resolve(import.meta.dir, "../../site/worker.ts"))));
  const server = hosting(config, root);
  stops.push(server.close);
  const timeout = setTimeout(() => { void server.close(); }, 20000);
  try { publicOrigin = await server.ready; } finally { clearTimeout(timeout); }
  const nativeConfig = join(root, "native.jsonc");
  const native = (await Bun.file(config).text()).replace(/^.*"main":.*\n/m, "").replace(/^.*"binding":.*\n/m, "").replace(/^.*"run_worker_first":.*\n/m, "");
  await Bun.write(nativeConfig, native);
  const baseline = hosting(nativeConfig, root);
  stops.push(baseline.close);
  const nativeTimeout = setTimeout(() => { void baseline.close(); }, 20000);
  try { nativeOrigin = await baseline.ready; } finally { clearTimeout(nativeTimeout); }
  const build = await Bun.build({ entrypoints: [resolve(import.meta.dir, "../../site/worker.ts")], target: "browser", format: "esm", outdir: join(root, "bundle") });
  if (!build.success || !build.outputs[0]) throw new Error(`Worker fixture bundle failed: ${build.logs.join("\n")}`);
  const direct = hosting(config, root, build.outputs[0].path);
  stops.push(direct.close);
  const directTimeout = setTimeout(() => { void direct.close(); }, 20000);
  try { origin = await direct.ready; } finally { clearTimeout(directTimeout); }
}, 25000);

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
    req.setTimeout(3000, () => req.destroy(new Error("Worker request timed out")));
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
  expect(response.headers["cache-control"]).toBe("public, max-age=60, no-transform");
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

test("Worker falls back to raw when a sidecar is absent, but honors identity refusal", async () => {
  const raw = program.replace("ls.wasm", "raw-only.wasm");
  expect((await get(raw, "br,gzip")).body).toEqual(wasm);
  expect((await get(raw, "br,gzip,identity;q=0")).status).toBe(406);
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
