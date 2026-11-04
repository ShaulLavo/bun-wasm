import { readFile, readdir, rm, symlink, writeFile, lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { object, fileIdentity, readVerifiedFile, recheckDependencies, verifyReviewedHostSource, type TlsIntake } from "../../scripts/tls-qualification-inputs.ts";
import { qualificationCases, assertCaseContext, isCase, type QualificationEngine } from "../../scripts/tls-qualification-context.ts";
import { acquireOwned, deadline, type TlsCleanup } from "../../scripts/tls-qualification-lifecycle.ts";
import { type startTlsServices, type ServiceOptions } from "./tls-relay-services.ts";

async function seedFiles(modules: string, name = ""): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const entry of await readdir(join(modules, name), { withFileTypes: true })) {
    const path = name ? `${name}/${entry.name}` : entry.name;
    if (entry.isDirectory()) { for (const [key, value] of await seedFiles(modules, path)) files.set(key, value); continue; }
    if (!entry.isFile()) throw new Error("pg staging must contain only regular package files");
    files.set(`node_modules/${path}`, join(modules, path));
  }
  return files;
}
function guestAsset(intake: TlsIntake, engine: QualificationEngine, origin: string) {
  const names = engine === "browser" ? ["browser/default/bun-browser.wasm"]
    : engine === "quickjs" ? ["split/dist/bun.wasm", "split/dist/quickjs.wasm"] : ["split/dist/bun-jsc.wasm", "split/dist/jsc-engine.wasm"];
  const files = names.map(path => {
    const row = intake.files.find(file => file.path === path);
    if (!row) throw new Error("Missing selected TLS guest artifact");
    return { url: `${origin}/artifact/${row.sha256}`, sha256: row.sha256, bytes: row.bytes };
  });
  const core = files[0];
  if (!core) throw new Error("Missing TLS core");
  if (engine === "browser") return { kind: "single", core };
  const side = files[1];
  if (!side) throw new Error("Missing TLS engine program");
  return { kind: engine, core, side };
}
async function build(intake: TlsIntake, scratch: string, signal: AbortSignal) {
  signal.throwIfAborted();
  await verifyReviewedHostSource(intake.inputs.hostSource, intake.source);
  await recheckDependencies(intake);
  signal.throwIfAborted();
  const root = intake.inputs.hostSource;
  const entry = join(scratch, "tls-relay-page.ts");
  let source = await readFile(new URL("./tls-relay-page.ts", import.meta.url), "utf8");
  for (const [old, replacement] of [
    ["../../src/assets.ts", join(root, "src/assets.ts")], ["../src/runner.ts", join(root, "web/src/runner.ts")],
    ["../../scripts/tls-qualification-context.ts", resolve(import.meta.dir, "../../scripts/tls-qualification-context.ts")],
  ]) source = source.replace(JSON.stringify(old), JSON.stringify(replacement));
  // Static spelling lets Bun resolve this to the exact reviewed C1 file, without copying it.
  source = source.replace('const entry = "tls-reviewed-relay";', '')
    .replace("await import(entry)", `await import(${JSON.stringify(join(root, "web/src/net/relay.ts"))})`);
  signal.throwIfAborted();
  await writeFile(entry, source, { flag: "wx" });
  signal.throwIfAborted();
  await symlink(join(root, "web/node_modules"), join(scratch, "node_modules"));
  signal.throwIfAborted();
  await verifyReviewedHostSource(root, intake.source);
  const api = object(await import(pathToFileURL(join(root, "scripts/browser-build.ts")).href), "reviewed browser builder");
  if (typeof api.buildBrowserEntries !== "function") throw new Error("Missing reviewed browser build helper");
  const out = join(scratch, "page");
  signal.throwIfAborted();
  await api.buildBrowserEntries([entry, join(root, "web/src/worker.ts"), join(root, "web/src/fs-worker.ts"), join(root, "web/src/notification-worker.ts")], out, { runtimeWorker: true });
  signal.throwIfAborted();
  await recheckDependencies(intake);
  await writeFile(join(out, "index.html"), '<!doctype html><title>Guest PostgreSQL TLS qualification</title><script type="module" src="/tls-relay-page.js"></script>');
  return out;
}
export async function runTlsBrowser(intake: TlsIntake, services: Awaited<ReturnType<typeof startTlsServices>>, owner: TlsCleanup, options: ServiceOptions, engine: QualificationEngine, scratch: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const out = await build(intake, scratch, signal);
  const outputs = await seedFiles(out);
  const hostOutputs = [];
  for (const [path, file] of outputs) hostOutputs.push({ path: path.slice("node_modules/".length), ...await fileIdentity(file) });
  const files = new Map(intake.dependencies.pg.files.map(row => [`node_modules/${row.path.slice(intake.dependencies.pg.root.length + 1)}`, row]));
  const origin = `http://127.0.0.1:${options.pagePort}`;
  const asset = guestAsset(intake, engine, origin);
  const artifactFiles = asset.kind === "single" ? [asset.core] : [asset.core, asset.side];
  const selectedArtifacts = artifactFiles.map(file => {
    if (!file) throw new Error("Selected guest artifact missing from the asset descriptor");
    const row = intake.files.find(candidate => candidate.sha256 === file.sha256 && candidate.bytes === file.bytes);
    if (!row) throw new Error("Selected guest artifact missing from the admitted delivery");
    return { ...file, path: join(intake.inputs.delivery, row.path) };
  });
  for (const file of selectedArtifacts) await readVerifiedFile(file);
  const headers = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp", "Cache-Control": "no-store" };
  await acquireOwned(owner, signal, () => Bun.serve({ hostname: "127.0.0.1", port: options.pagePort, fetch: respond }), async server => {
    await server.stop(true);
    if (server.pendingRequests || server.pendingWebSockets) throw new Error("TLS page listener cleanup unconfirmed");
  });
  async function respond(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.origin !== origin) return new Response(null, { status: 403 });
    if (request.method === "POST") return post(request, url.pathname);
    if (request.method !== "GET") return new Response(null, { status: 405 });
    if (url.pathname === "/seed") return Response.json(Array.from(files.keys()), { headers });
    if (url.pathname === "/pg-client.ts") return new Response(Bun.file(new URL("./fixtures/tls/pg-client.ts", import.meta.url)), { headers });
    const seed = files.get(url.pathname.slice("/seed/".length));
    if (url.pathname.startsWith("/seed/") && seed) return new Response(await readVerifiedFile(seed), { headers });
    const artifact = selectedArtifacts.find(file => url.pathname === `/artifact/${file.sha256}`);
    if (artifact) return new Response(await readVerifiedFile(artifact), { headers: { ...headers, "Content-Type": "application/wasm" } });
    const path = resolve(out, `.${url.pathname === "/" ? "/index.html" : url.pathname}`);
    if (!path.startsWith(out + "/") || !await Bun.file(path).exists()) return new Response(null, { status: 404 });
    return new Response(Bun.file(path), { headers });
  }
  async function post(request: Request, path: string): Promise<Response> {
    if (request.headers.get("origin") !== origin || signal.aborted) return new Response(null, { status: 403 });
    if (path === "/lifecycle") return Response.json(services.lifecycle(), { headers });
    if (path === "/token") return new Response(await services.token(), { headers });
    const mode = path.slice("/case/".length);
    if (!path.startsWith("/case/") || !isCase(mode)) return new Response(null, { status: 404 });
    services.select(mode);
    return Response.json({ engine, asset, ca: services.ca, password: services.password, endpoint: `http://127.0.0.1:${options.relayPort}` }, { headers });
  }
  signal.throwIfAborted();
  await recheckDependencies(intake);
  signal.throwIfAborted();
  await verifyReviewedHostSource(intake.inputs.hostSource, intake.source);
  const playwright: typeof import("playwright") = await import(pathToFileURL(Bun.resolveSync("playwright", intake.inputs.hostSource)).href);
  const browser = await acquireOwned(owner, signal, () => playwright.chromium.launch({ headless: true }), browser => browser.close());
  let cancellationClose: Promise<void> | undefined;
  const stopBrowser = () => { cancellationClose ??= browser.close(); void cancellationClose.catch(() => {}); };
  signal.addEventListener("abort", stopBrowser, { once: true });
  owner.add(async () => { signal.removeEventListener("abort", stopBrowser); await cancellationClose; });
  if (signal.aborted) stopBrowser();
  const context = await acquireOwned(owner, signal, () => browser.newContext(), context => context.close());
  const page = await acquireOwned(owner, signal, () => context.newPage(), async page => {
    if (!page.isClosed()) await page.evaluate(async () => { const api = Reflect.get(globalThis, "tlsQualification"); if (api) await api.cancel(); });
    await page.close();
  });
  signal.throwIfAborted();
  await page.goto(origin);
  await page.waitForFunction(() => !!Reflect.get(globalThis, "tlsQualification"));
  const rows = [];
  for (const mode of qualificationCases) {
    const raw = await deadline(page.evaluate(mode => Reflect.get(globalThis, "tlsQualification").runCase(mode), mode), signal, 90_000);
    rows.push({ ...assertCaseContext(raw, mode, engine), wire: await services.audit(mode) });
  }
  const seeds = intake.dependencies.pg.files;
  return { ok: true, browser: "chromium", version: browser.version(), engine, carrier: "websocket", rows, seedIdentities: seeds,
    preflightReferences: intake.references, pgArchive: intake.pgArchive, frozenLocks: intake.dependencies.locks, hostDependencies: intake.dependencies.host, source: intake.source, tuple: intake.tuple, guestAsset: asset, hostOutputs, trustScope: "run-generated-extra-CA; not bundled-public-roots", verificationBarrier: "armed native TLS destination saw zero startup/password bytes on trust-failure controls; SSL rejection sent only SSLRequest" };
}
export async function removeTlsScratch(path: string) {
  await rm(path, { recursive: true, force: true });
  try { await lstat(path); } catch (error) { if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return { path, lstatError: error.code }; throw error; }
  throw new Error("TLS qualification scratch cleanup unconfirmed");
}
