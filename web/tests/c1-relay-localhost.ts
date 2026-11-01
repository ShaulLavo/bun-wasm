import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { existsSync } from "node:fs";
import { c1InputPaths, c1Ports, admitC1Guest, C1Cleanup } from "./c1-relay-inputs";
import { assertCarrier, localhostOrigin, modes, requireLocalTopology } from "./fixtures/c1-relay/protocol";

const root = resolve(import.meta.dir, "../..");

async function seedPg(modules: string, output: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  let packages = ["pg"];
  const seen = new Set<string>();
  while (packages.length) {
    const name = packages.pop()!;
    if (seen.has(name)) continue;
    seen.add(name);
    if (!/^(@[a-z0-9_-]+\/)?[a-z0-9_-]+$/.test(name)) throw new Error("Unsafe C1 pg dependency name");
    const directory = join(modules, name);
    const metadata = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
    packages = packages.concat(Object.keys(metadata.dependencies ?? {}));
    await copyPackage(directory, `node_modules/${name}`, output, files);
  }
  return files;
}
async function copyPackage(source: string, target: string, output: string, files: Map<string, string>): Promise<void> {
  await mkdir(join(output, target), { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name), to = `${target}/${entry.name}`;
    if (entry.isDirectory()) { await copyPackage(from, to, output, files); continue; }
    if (!entry.isFile()) throw new Error("C1 pg fixture requires ordinary package files, not links");
    const path = join(output, to);
    await writeFile(path, await readFile(from), { flag: "wx", mode: 0o400 });
    files.set(to, path);
  }
}

export function assertC1Result(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || !("ok" in value) || value.ok !== true
    || !("rows" in value) || !Array.isArray(value.rows) || !("cleanup" in value)) throw new Error("C1 page did not pass");
  if (JSON.stringify(value.rows.map(row => row?.mode)) !== JSON.stringify(modes)) throw new Error("C1 page omitted a selected mode");
  const cleanup = value.cleanup;
  if (!cleanup || typeof cleanup !== "object" || !("workers" in cleanup) || cleanup.workers !== 0
    || !("runtimeDisposed" in cleanup) || cleanup.runtimeDisposed !== true || !("relayClosed" in cleanup) || cleanup.relayClosed !== true) throw new Error("C1 page cleanup was not confirmed");
}


export function safeC1Result(value: unknown) {
  assertC1Result(value);
  if (!Array.isArray(value.rows)) throw new Error("C1 page rows missing");
  return { ok: true, rows: value.rows.map(safeRow), cleanup: { workers: 0, runtimeDisposed: true, relayClosed: true } };
}
function safeRow(row: unknown) {
  if (!row || typeof row !== "object" || !("mode" in row) || !("carriers" in row) || !Array.isArray(row.carriers)
    || !("query" in row) || !("bunPreview1Adapter" in row)) throw new Error("C1 row is incomplete");
  const mode = row.mode;
  if (mode !== "automatic" && mode !== "websocket" && mode !== "no-relay") throw new Error("C1 row mode is invalid");
  const carriers: Array<"websocket" | "webtransport"> = [];
  for (const carrier of row.carriers) {
    if (carrier !== "websocket" && carrier !== "webtransport") throw new Error("C1 row carrier is invalid");
    carriers.push(carrier);
  }
  assertCarrier(mode, carriers, mode === "no-relay" ? 0 : 2);
  const query = mode === "no-relay" ? "loopback and ENOTSUP" : "SELECT 1";
  if (row.query !== query || row.bunPreview1Adapter !== (mode !== "no-relay")) throw new Error("C1 row proof is incomplete");
  return { mode, carriers, query, bunPreview1Adapter: mode !== "no-relay" };
}


function serveC1Page(options: {
  admitted: Awaited<ReturnType<typeof admitC1Guest>>;
  services: Awaited<ReturnType<typeof import("./c1-relay-services").startC1Services>>;
  files: Map<string, string>; out: string; origin: string; endpoint: string; port: number;
  preview1: ReturnType<typeof c1InputPaths>["preview1"];
  abort: AbortController; result: ReturnType<typeof Promise.withResolvers<unknown>>;
}) {
  const { admitted, services, files, out, origin, endpoint, port, abort, result, preview1 } = options;
  const artifacts = [admitted.artifact.files.core].concat(admitted.artifact.files.kind === "single" ? [] : [admitted.artifact.files.side]);
  const headers = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp", "Cache-Control": "no-store" };
  const server = Bun.serve({ hostname: "127.0.0.1", port, fetch: respond });
  async function respond(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.origin !== origin) return new Response(null, { status: 403 });
    if (request.method === "POST") return post(request);
    if (request.method !== "GET") return new Response(null, { status: 405 });
    if (url.pathname === "/config") return Response.json({ asset: admitted.artifact.descriptor, engine: admitted.engine, endpoint, preview1: { target: { host: preview1.host, port: preview1.port }, expectedStdout: preview1.expectedStdout } }, { headers });
    if (url.pathname === "/control") return Response.json(abort.signal.aborted ? "stop" : "run", { headers });
    if (url.pathname === "/seed") return Response.json(Array.from(files.keys()), { headers });
    if (url.pathname === "/line.wasm") return new Response(admitted.preview1, { headers: { ...headers, "Content-Type": "application/wasm" } });
    const seed = files.get(url.pathname.slice("/seed/".length));
    if (url.pathname.startsWith("/seed/") && seed) return new Response(Bun.file(seed), { headers });
    const artifact = artifacts.find(file => url.pathname === `/artifacts/${file.descriptor.sha256}`);
    if (artifact) return artifactResponse(artifact.gzip, headers);
    const path = resolve(out, `.${url.pathname === "/" ? "/index.html" : url.pathname}`);
    if (!path.startsWith(out + sep) || !await Bun.file(path).exists()) return new Response(null, { status: 404, headers });
    return new Response(Bun.file(path), { headers });
  }
  async function post(request: Request): Promise<Response> {
    if (request.headers.get("origin") !== origin) return new Response(null, { status: 403 });
    const path = new URL(request.url).pathname;
    if (path === "/database" && !abort.signal.aborted) return Response.json(services.databaseEnvironment(), { headers });
    if (path === "/token" && !abort.signal.aborted) return new Response(await services.token(), { headers });
    if (path !== "/result") return new Response(null, { status: 404 });
    if (Number(request.headers.get("content-length") ?? "0") > 16384) return new Response(null, { status: 413 });
    const text = await request.text();
    if (text.length > 16384) return new Response(null, { status: 413 });
    result.resolve(JSON.parse(text));
    return new Response(null, { status: 204, headers });
  }
  return server;
}

function artifactResponse(gzip: Uint8Array, headers: Record<string, string>): Response {
  const buffer = gzip.buffer;
  if (!(buffer instanceof ArrayBuffer)) throw new Error("C1 artifact backing storage is not an ArrayBuffer");
  return new Response(new Uint8Array(buffer, gzip.byteOffset, gzip.byteLength), { headers: { ...headers, "Content-Type": "application/gzip" } });
}
async function stopPageServer(server: ReturnType<typeof Bun.serve>): Promise<void> {
  await server.stop(true);
  if (server.pendingRequests || server.pendingWebSockets) throw new Error("C1 page listener cleanup unconfirmed");
}

async function waitForPageResult(result: Promise<unknown>, signal: AbortSignal): Promise<unknown> {
  const cancelled = Promise.withResolvers<never>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    // Give the page time to observe /control and await process/helper teardown.
    timer = setTimeout(() => cancelled.reject(new Error("C1 page cleanup acknowledgement missing after stop")), 20_000);
  };
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) stop();
  try { return await Promise.race([result, cancelled.promise]); }
  finally { signal.removeEventListener("abort", stop); clearTimeout(timer); }
}

async function run(action: string | undefined): Promise<void> {
  if (action !== "--preflight" && action !== "--serve") throw new Error("Usage: source env.sh && bun web/tests/c1-relay-localhost.ts --preflight|--serve");
  // Missing/unadmitted packets fail before build, subprocesses, service or browser setup.
  requireLocalTopology(process.env.C1_TOPOLOGY);
  const inputs = c1InputPaths(process.env);
  const ports = c1Ports(process.env);
  const scratchRoot = process.env.NETWORK_SCRATCH_ROOT;
  if (!scratchRoot || !isAbsolute(scratchRoot)) throw new Error("NETWORK_SCRATCH_ROOT requires a writable data-drive directory");
  const scratch = await mkdtemp(join(scratchRoot, "bun-wasm-c1-"));
  const owner = new C1Cleanup();
  owner.add(async () => {
    const artifacts = join(scratch, "artifacts");
    if (existsSync(artifacts)) await chmod(artifacts, 0o700);
    await rm(scratch, { recursive: true, force: true });
    if (existsSync(scratch)) throw new Error("C1 scratch cleanup unconfirmed");
  });
  const abort = new AbortController();
  const stop = () => abort.abort(new Error("C1 fixture stopped"));
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.once(signal, stop);
  const deadline = setTimeout(stop, 10 * 60_000);
  try {
    const admitted = await admitC1Guest(inputs, scratch);
    abort.signal.throwIfAborted();
    if (action === "--preflight") { console.log(JSON.stringify({ admitted: true, execution: "not started", engine: admitted.engine })); return; }
    const out = join(scratch, "page");
    const files = await seedPg(inputs.pgModules, join(scratch, "seed"));
    const { buildBrowserEntries } = await import("../../scripts/browser-build");
    await buildBrowserEntries([join(import.meta.dir, "c1-relay-page.ts"), join(root, "web/src/worker.ts"),
      join(root, "web/src/fs-worker.ts"), join(root, "web/src/notification-worker.ts")], out, { runtimeWorker: true });
    await writeFile(join(out, "index.html"), '<!doctype html><title>C1 localhost relay fixture</title><body>Running C1 localhost checks<script type="module" src="./c1-relay-page.js"></script>');
    abort.signal.throwIfAborted();
    const { startC1Services } = await import("./c1-relay-services");
    const services = await startC1Services(owner, ports, inputs.preview1, abort.signal);
    const origin = localhostOrigin(`http://127.0.0.1:${ports.page}/`);
    const endpoint = `http://127.0.0.1:${ports.relay}/`;
    const result = Promise.withResolvers<unknown>();
    const server = serveC1Page({ admitted, services, files, out, origin, endpoint, port: ports.page, abort, result, preview1: inputs.preview1 });
    owner.add(() => stopPageServer(server));
    console.log(JSON.stringify({ origin, resources: services.resources, browser: "operator-owned; none launched by this runner", execution: "open this localhost URL on this execution host only" }));
    const report = await waitForPageResult(result.promise, abort.signal);
    assertC1Result(report);
    console.log(JSON.stringify(safeC1Result(report)));
  } finally {
    clearTimeout(deadline);
    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.removeListener(signal, stop);
    await owner.close();
  }
}

if (import.meta.main) await run(process.argv[2]);
