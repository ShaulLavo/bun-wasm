import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { brotliCompressSync, gzipSync } from "node:zlib";

const wasm = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
const brotli = brotliCompressSync(wasm);
const gzip = gzipSync(wasm);
const program = "/programs/base/waffle-coreutils/dist/ls.wasm";
let root: string;
let origin: string;
let stop: (() => Promise<void>) | undefined;

function hosting(config: string, directory: string) {
  const node = Bun.which("node");
  if (!node) throw new Error("Local Worker proof requires Node for pinned Wrangler");
  const child = spawn(node, [resolve(import.meta.dir, "../../node_modules/wrangler/bin/wrangler.js"), "dev", "--config", config,
    "--local", "--ip", "127.0.0.1", "--port", "0", "--inspector-port", "0", "--persist-to", join(directory, "state"),
    "--show-interactive-dev-session=false"], {
    cwd: directory, detached: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", WRANGLER_LOG_PATH: join(directory, "wrangler.log") },
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
  await Bun.write(join(assets, program), wasm);
  await Bun.write(join(assets, program + ".br"), brotli);
  await Bun.write(join(assets, program + ".gz"), gzip);
  await Bun.write(join(assets, "_headers"), await Bun.file(join(import.meta.dir, "../_headers")).text());
  const original = await Bun.file(join(import.meta.dir, "../../site/wrangler.jsonc")).text();
  const config = join(root, "wrangler.jsonc");
  await Bun.write(config, original.replace('"./dist"', JSON.stringify(assets)).replace('"worker.ts"', JSON.stringify(resolve(import.meta.dir, "../../site/worker.ts"))));
  const server = hosting(config, root);
  stop = server.close;
  const timeout = setTimeout(() => { void server.close(); }, 20000);
  try { origin = await server.ready; } finally { clearTimeout(timeout); }
}, 25000);

afterAll(async () => {
  await stop?.();
  if (root) await rm(root, { recursive: true, force: true });
});

function get(path: string, encoding: string) {
  return new Promise<{ status: number; headers: import("node:http").IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    const req = request(new URL(path, origin), { headers: { "accept-encoding": encoding } }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.setTimeout(3000, () => req.destroy(new Error("Worker request timed out")));
    req.end();
  });
}

test("public hosting selects the supplied Brotli sidecar at the logical program URL", async () => {
  const response = await get(program, "br, gzip");
  expect(response.status).toBe(200);
  expect(response.headers["content-encoding"]).toBe("br");
  expect(response.headers["content-type"]).toBe("application/wasm");
  expect(response.body).toEqual(brotli);
});
