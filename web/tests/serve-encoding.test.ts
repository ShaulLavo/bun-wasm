import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync } from "node:zlib";

const wasm = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
const brotli = brotliCompressSync(wasm);
let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "bun-wasm-serving-"));
  await Bun.write(join(root, "ls.wasm"), wasm);
  await Bun.write(join(root, "ls.wasm.br"), brotli);
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
