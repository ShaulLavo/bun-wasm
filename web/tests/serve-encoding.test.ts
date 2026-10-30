import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync, brotliDecompressSync, gunzipSync } from "node:zlib";

const wasm = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
const brotli = brotliCompressSync(wasm);
const gzip = Buffer.from(Bun.gzipSync(wasm));
let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "bun-wasm-serving-"));
  await Bun.write(join(root, "ls.wasm"), wasm);
  await Bun.write(join(root, "ls.wasm.br"), brotli);
  await Bun.write(join(root, "ls.wasm.gz"), gzip);
  await Bun.write(join(root, "br-only.wasm.br"), brotli);
  await Bun.write(join(root, "gzip-only.wasm.gz"), gzip);
  await Bun.write(join(root, "raw-only.wasm"), wasm);
  await Bun.write(join(root, "index.html"), "<h1>fixture</h1>");
  await Bun.write(join(root, "_headers"), "/ls.wasm\n  Cache-Control: public, max-age=60\n");
});
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

async function preview(isolate = true) {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../serve.ts")], {
    env: { ...process.env, ROOT: root, HOST: "127.0.0.1", PORT: "0", ISOLATE: isolate ? "1" : "0", PREVIEW_ORIGINS: "0", LATENCY_MS: "0" },
    stdout: "pipe", stderr: "inherit",
  });
  const reader = child.stdout.getReader();
  const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    const { value } = await reader.read();
    const url = / at (http:\/\/\S+) /.exec(new TextDecoder().decode(value))?.[1];
    if (!url) throw new Error("Preview did not report its listening URL");
    return { url, async [Symbol.asyncDispose]() { child.kill(); await child.exited; } };
  } catch (error) {
    child.kill();
    await child.exited;
    throw error;
  } finally {
    clearTimeout(timeout);
    reader.releaseLock();
  }
}

function get(url: string, encoding: string | undefined) {
  return new Promise<{ status: number; headers: import("node:http").IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    const req = request(url, { headers: encoding === undefined ? {} : { "accept-encoding": encoding } }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.setTimeout(3000, () => req.destroy(new Error("Preview request timed out")));
    req.end();
  });
}

test("serves the supplied Brotli representation at the original wasm URL", async () => {
  await using server = await preview();
  const response = await get(new URL("ls.wasm", server.url).href, "br");
  expect(response.status).toBe(200);
  expect(response.headers["content-encoding"]).toBe("br");
  expect(response.headers["content-type"]).toBe("application/wasm");
  expect(response.body).toEqual(brotli);
});


const negotiation: [string | undefined, string | undefined][] = [
  [undefined, undefined], ["", undefined], ["br, gzip", "br"],
  ["gzip;q=0.8, br;q=0.2", "gzip"], ["br;q=0, gzip", "gzip"],
  ["gzip;q=0, br", "br"], ["br;q=0, gzip;q=0", undefined],
  ["*", "br"], ["*;q=0.5, br;q=0", "gzip"],
  ["*;q=0, br;q=0.5", "br"], ["*;q=0, identity;q=1", undefined],
  ["br;q=0.2, gzip;q=0.1, identity;q=0.8", undefined],
  ["br;q=0.001, gzip;q=0", "br"], ["BR;Q=1.000, gzip;q=0", "br"],
  ["deflate", undefined], ["identity", undefined], ["x-gzip", "gzip"],
  ["br;q=0, br;q=1, gzip;q=0", undefined],
  ["br;q=1., gzip;q=0.", "br"], [", br, , gzip,", "br"],
];

test.each(negotiation)("negotiates Accept-Encoding %s without changing the decoded module", async (encoding, expected) => {
  await using server = await preview();
  const response = await get(new URL("ls.wasm", server.url).href, encoding);
  expect(response.status).toBe(200);
  expect(response.headers["content-encoding"]).toBe(expected);
  expect(response.headers["content-type"]).toBe("application/wasm");
  expect(response.headers["vary"]).toBe("Accept-Encoding");
  expect(response.headers["cross-origin-opener-policy"]).toBe("same-origin");
  expect(response.headers["cross-origin-embedder-policy"]).toBe("require-corp");
  expect(response.headers["cache-control"]).toBe("public, max-age=60");
  const body = expected === "br" ? brotliDecompressSync(response.body) : expected === "gzip" ? gunzipSync(response.body) : response.body;
  expect(body).toEqual(wasm);
  expect(response.body).toEqual(expected === "br" ? brotli : expected === "gzip" ? gzip : wasm);
  expect(response.headers["content-length"]).toBe(String(response.body.length));
  expect(response.headers["x-uncompressed-length"]).toBe(expected === "gzip" ? String(wasm.length) : undefined);
});

test.each(["*;q=0", "br;q=0,gzip;q=0,identity;q=0", "identity;q=0,deflate"])("returns 406 when every representation is refused by %s", async encoding => {
  await using server = await preview();
  const response = await get(new URL("ls.wasm", server.url).href, encoding);
  expect(response.status).toBe(406);
  expect(response.headers["content-encoding"]).toBeUndefined();
  expect(response.headers["vary"]).toBe("Accept-Encoding");
  expect(response.headers["cross-origin-opener-policy"]).toBe("same-origin");
  expect(response.headers["cross-origin-embedder-policy"]).toBe("require-corp");
  expect(response.body.length).toBe(0);
});

test.each(["br;q=2", "gzip;q=-1", "br;q=0.1234", "gzip;q=.5", "br;q=no", "br;level=3"])("rejects malformed negotiation at the HTTP boundary: %s", async encoding => {
  await using server = await preview();
  const response = await get(new URL("ls.wasm", server.url).href, encoding);
  expect(response.status).toBe(400);
  expect(response.headers["content-encoding"]).toBeUndefined();
  expect(response.headers["vary"]).toBe("Accept-Encoding");
  expect(response.headers["cross-origin-embedder-policy"]).toBe("require-corp");
});

const availability: [string, string | undefined, number, string | undefined][] = [
  ["br-only", "br", 200, "br"], ["br-only", undefined, 200, undefined],
  ["br-only", "br;q=0", 200, undefined], ["br-only", "gzip,identity;q=0", 406, undefined],
  ["gzip-only", "gzip", 200, "gzip"], ["gzip-only", "br", 200, undefined],
  ["gzip-only", undefined, 200, undefined], ["gzip-only", "gzip;q=0", 200, undefined],
  ["gzip-only", "br,identity;q=0", 406, undefined],
  ["raw-only", "br,gzip", 200, undefined], ["raw-only", "identity;q=0", 406, undefined],
  ["missing", "br,gzip", 404, undefined],
];

test.each(availability)("serves only actual variants for %s with %s", async (name, encoding, status, expected) => {
  await using server = await preview();
  const response = await get(new URL(`${name}.wasm`, server.url).href, encoding);
  expect(response.status).toBe(status);
  expect(response.headers["content-encoding"]).toBe(expected);
  expect(response.headers["vary"]).toBe("Accept-Encoding");
  expect(response.headers["cross-origin-opener-policy"]).toBe("same-origin");
  if (status !== 200) return;
  expect(response.headers["content-type"]).toBe("application/wasm");
  expect(response.body).toEqual(expected === "br" ? brotli : expected === "gzip" ? gzip : wasm);
});

test("does not read unrelated program bodies or refused compressed variants", async () => {
  await using server = await preview();
  await Bun.write(join(root, "unrelated.wasm.br"), "deliberately invalid Brotli");
  await Bun.write(join(root, "raw-only.wasm.br"), "deliberately invalid Brotli");
  await Bun.write(join(root, "raw-only.wasm.gz"), "deliberately invalid gzip");
  const response = await get(new URL("raw-only.wasm", server.url).href, "br;q=0");
  expect(response.status).toBe(200);
  expect(response.body).toEqual(wasm);
});

test("keeps ordinary HTML MIME and no-store behavior", async () => {
  await using server = await preview();
  const response = await get(new URL("index.html", server.url).href, "br,gzip");
  expect(response.status).toBe(200);
  expect(response.headers["content-type"]).toStartWith("text/html");
  expect(response.headers["content-encoding"]).toBeUndefined();
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.body.toString()).toBe("<h1>fixture</h1>");
});

test("ISOLATE=0 leaves isolation disabled for negotiated responses", async () => {
  await using server = await preview(false);
  const response = await get(new URL("ls.wasm", server.url).href, "br");
  expect(response.headers["content-encoding"]).toBe("br");
  expect(response.headers["cross-origin-opener-policy"]).toBeUndefined();
  expect(response.headers["cross-origin-embedder-policy"]).toBeUndefined();
});
