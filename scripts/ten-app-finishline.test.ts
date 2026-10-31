import { expect, test } from "bun:test";
import { recipe, targets } from "../tests/ten-app-finishline/recipes.ts";
import { fullstackApps } from "./app-matrix/product-fullstack.ts";

test("finish line retains exactly the owner's ten app families", () => {
  expect(targets).toEqual(["vite-react", "next", "sveltekit", "nuxt", "astro", "react-router", "solidstart", "tanstack-start", "hono", "express"]);
  expect(new Set(targets).size).toBe(10);
  for (const unsupported of ["vitest", "prisma", "koa", "next16", ""]) expect(() => recipe(unsupported)).toThrow();
});
for (const id of ["hono", "express"]) {
  test(`${id} has real development and production sources with a required build`, () => {
    const fixture = recipe(id);
    expect(fixture.dependencies[id]).toBeTruthy();
    expect(fixture.scripts.dev).toBeTruthy();
    expect(fixture.scripts.build).toBeTruthy();
    expect(fixture.scripts.start).toBeTruthy();
    expect(fixture.buildOutputs).toEqual(["dist/production.js"]);
    expect(fixture.files["app.ts"]).toContain(`from '${id}'`);
    expect(fixture.files["app.ts"]).toContain(fixture.text);
    expect(fixture.files["production.ts"]).toContain("import app from './app'");
  });
}
test("SvelteKit uses maintained sources for the full lifecycle", () => {
  const original = fullstackApps.find(app => app.id === "fullstack-sveltekit");
  if (!original) throw new Error("Missing maintained SvelteKit fixture");
  const fixture = recipe("sveltekit");
  expect(fixture.files).toBe(original.files);
  expect(fixture.dependencies).toBe(original.dependencies);
  expect(fixture.scripts).toHaveProperty("dev");
  expect(fixture.scripts.build).toBe("vite build");
  expect(fixture.scripts.start).toBe("bun run start.ts ${PORT:-3137}");
  expect(fixture.editPath).toBe("src/routes/+page.svelte");
  expect(fixture.files[fixture.editPath]).toContain(fixture.text);
  expect(fixture.buildOutputs).toEqual(["build/index.js", "build/handler.js", "build/server/index.js"]);
});

import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { hash, type SourceManifest } from "./guest-source-manifest.ts";

const runner = resolve(import.meta.dir, "../web/tests/ten-app-finishline.ts");
async function guestFixture(directory: string) {
  const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
  const digest = hash(bytes);
  const input = { path: "input", sha256: hash("input"), bytes: 5 };
  const source = { head: "b".repeat(40), tree: "c".repeat(40) };
  const manifest: SourceManifest = {
    schema: 1, build: "source-cache-browser", source,
    groups: ["repository", "bun", "waffle-libc", "sysroot", "sdk", "rust-target", "boringssl"].map(name => ({ name, files: [name === "sysroot" ? { ...input, path: "bun-wasm-sysroot.json" } : input] })),
    tools: ["rustc", "cargo", "bun", "node", "rust-lld", "clang", "clang++", "llvm-ar", "wasm-ld", "cmake", "ninja"].map(name => ({ name, path: `/tools/${name}`, sha256: input.sha256, version: "fixture" })),
    omissions: ["Synthetic receipt control; never executed as an app"],
  };
  const artifact = join(directory, "guest.wasm");
  const accepted = join(directory, "receipt.txt");
  await writeFile(artifact, bytes);
  await writeFile(`${artifact}.build.json`, JSON.stringify({ bunHead: source.head, bunTree: source.tree, sysrootReceiptSha256: input.sha256, sourceManifest: manifest, sourceManifestSha256: hash(JSON.stringify(manifest)), program: { kind: "single", core: { artifactSha256: digest, artifactBytes: bytes.length } } }));
  await writeFile(accepted, `source_commit=${source.head}\nsource_tree=${source.tree}\nguest_sha256=${digest}\nguest_bytes=${bytes.length}\ndate=2026-10-27\nfeatures=control\ntarget=wasm32-wasip1\n`);
  return { artifact, accepted, digest, source, bytes };
}
async function runnerPreflight(directory: string, env: Record<string, string>) {
  const reports = join(directory, "reports");
  const child = Bun.spawn([process.execPath, runner, "hono"], { cwd: directory, env: { ...process.env, TEN_APP_REPORT: reports, TEN_APP_SCRATCH: join(directory, "scratch-"), SHELL_PRODUCT_INSTALL: join(directory, "missing-install"), SHELL_PRODUCT_REGISTRY: join(directory, "corpus"), ...env }, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
  try {
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    return { code, stderr, reports };
  } finally { clearTimeout(timer); }
}
for (const invalid of ["relative", "mismatch"]) {
  test(`actual runner rejects ${invalid} accepted guest selection before bundling`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "bw-ten-preflight-"));
    try {
      const guest = await guestFixture(directory);
      if (invalid === "mismatch") await writeFile(guest.accepted, (await readFile(guest.accepted, "utf8")).replace(guest.digest, "d".repeat(64)));
      const result = await runnerPreflight(directory, { SHELL_PRODUCT_GUEST: invalid === "relative" ? "guest.wasm" : guest.artifact, SHELL_PRODUCT_RECEIPT: guest.accepted });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(invalid === "relative" ? "absolute SHELL_PRODUCT_GUEST" : "Guest receipt does not match");
      const failure = await Bun.file(join(result.reports, "failure.json")).json();
      expect(failure.primary).toContain(invalid === "relative" ? "absolute SHELL_PRODUCT_GUEST" : "Guest receipt does not match");
      expect(await Bun.file(join(result.reports, "external.json")).json()).toEqual([]);
      expect(await Bun.file(join(result.reports, "registry.json")).json()).toBeNull();
    } finally { await rm(directory, { recursive: true, force: true }); }
  }, 5000);
}

import { readdir, chmod } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import { acceptedGuest, createFinishlineRun, openRegistry, runMode, networkSnapshot } from "../tests/ten-app-finishline/acceptance.ts";
import { bounded } from "../tests/shell-product/lifecycle.ts";

test("accepted preflight retains source, digest, bytes and rejects a different source receipt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bw-ten-identity-"));
  try {
    const guest = await guestFixture(directory);
    const env = { SHELL_PRODUCT_GUEST: guest.artifact, SHELL_PRODUCT_RECEIPT: guest.accepted };
    const accepted = await acceptedGuest(env);
    expect(accepted.provenance).toMatchObject({ source_commit: guest.source.head, source_tree: guest.source.tree, artifact_sha256: guest.digest, artifact_bytes: guest.bytes.length });
    await expect(acceptedGuest({ ...env, SHELL_PRODUCT_RECEIPT: "receipt.txt" })).rejects.toThrow("absolute SHELL_PRODUCT_GUEST");
    await writeFile(guest.accepted, (await readFile(guest.accepted, "utf8")).replace(guest.source.head, "e".repeat(40)));
    await expect(acceptedGuest(env)).rejects.toThrow("Accepted guest source differs");
    await writeFile(guest.accepted, (await readFile(guest.accepted, "utf8")).replace("e".repeat(40), guest.source.head));
    const result = await runnerPreflight(directory, env);
    expect(result.code).toBe(1);
    const inputs = await Bun.file(join(result.reports, "inputs.json")).json();
    expect(inputs.guestProvenance).toEqual(accepted.provenance);
    expect(inputs.guestArtifact).toBe(guest.artifact);
    expect(inputs.acceptedReceipt).toBe(guest.accepted);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
async function corpusFixture(directory: string) {
  const objects = join(directory, "objects");
  await mkdir(objects);
  const body = JSON.stringify({ name: "control", versions: {} });
  const digest = hash(body);
  const index = JSON.stringify({ "/control": { status: 200, type: "application/json", sha256: digest } });
  await writeFile(join(objects, digest), body);
  await writeFile(join(directory, "index.json"), index);
  return { objects, index, digest };
}
test("acceptance replay cannot record misses and never changes the supplied corpus", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bw-ten-replay-"));
  const original = process.env.MATRIX_RECORDER_SOCKET;
  let mirror: Awaited<ReturnType<typeof openRegistry>> | undefined;
  let broker: ReturnType<typeof Bun.serve> | undefined;
  try {
    const corpus = await corpusFixture(directory);
    let upstream = 0;
    const socket = join(directory, "broker.sock");
    broker = Bun.serve({ unix: socket, fetch: () => { upstream++; return Response.json({ name: "missing", versions: {} }); } });
    process.env.MATRIX_RECORDER_SOCKET = socket;
    await chmod(join(directory, "index.json"), 0o444);
    await chmod(corpus.objects, 0o555);
    mirror = await openRegistry(directory, "acceptance");
    expect((await fetch(`${mirror.base}/control`)).status).toBe(200);
    expect((await fetch(`${mirror.base}/missing`)).status).toBe(503);
    expect(upstream).toBe(0);
    expect(mirror.snapshot().misses).toEqual(["/missing"]);
    expect(await readFile(join(directory, "index.json"), "utf8")).toBe(corpus.index);
    expect(await readdir(corpus.objects)).toEqual([corpus.digest]);
    await chmod(corpus.objects, 0o755);
    await rm(join(corpus.objects, corpus.digest));
    expect((await fetch(`${mirror.base}/control`)).status).toBe(502);
    expect(mirror.errors).toHaveLength(1);
    const events: string[] = [];
    const acceptance = createFinishlineRun({
      cleanup: cleanupControl(events),
      snapshot: () => networkSnapshot(mirror, [], () => {}),
      report: () => {},
    });
    expect(await acceptance.run(async () => {})).toBe(1);
  } finally {
    await mirror?.close(); await broker?.stop(true);
    if (original === undefined) delete process.env.MATRIX_RECORDER_SOCKET;
    else process.env.MATRIX_RECORDER_SOCKET = original;
    await chmod(join(directory, "objects"), 0o755);
    await rm(directory, { recursive: true, force: true });
  }
});
test("recording is explicit preparation and a missing replay directory is not created", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bw-ten-record-"));
  const original = process.env.MATRIX_RECORDER_SOCKET;
  let mirror: Awaited<ReturnType<typeof openRegistry>> | undefined;
  let broker: ReturnType<typeof Bun.serve> | undefined;
  try {
    expect(runMode([])).toBe("acceptance");
    expect(runMode(["--prepare-registry"])).toBe("prepare-registry");
    expect(() => runMode(["--record"])).toThrow("Usage");
    await expect(openRegistry(join(directory, "absent"), "acceptance")).rejects.toThrow();
    expect(await Bun.file(join(directory, "absent/index.json")).exists()).toBe(false);
    const socket = join(directory, "broker.sock");
    broker = Bun.serve({ unix: socket, fetch: () => Response.json({ name: "control", versions: {} }) });
    process.env.MATRIX_RECORDER_SOCKET = socket;
    const corpus = join(directory, "prepared");
    mirror = await openRegistry(corpus, "prepare-registry");
    expect((await fetch(`${mirror.base}/control`)).status).toBe(200);
    expect(await Bun.file(join(corpus, "index.json")).exists()).toBe(true);
    await mirror.close(); mirror = undefined;
    expect(await Bun.file(join(corpus, "record.lock")).exists()).toBe(false);
  } finally {
    await mirror?.close(); await broker?.stop(true);
    if (original === undefined) delete process.env.MATRIX_RECORDER_SOCKET;
    else process.env.MATRIX_RECORDER_SOCKET = original;
    await rm(directory, { recursive: true, force: true });
  }
});
type Failure = Parameters<Parameters<typeof createFinishlineRun>[0]["report"]>[0];
function cleanupControl(events: string[]) {
  return {
    captureTimeout: 15,
    capture: async () => { events.push("capture"); },
    closeBrowser: async () => { events.push("browser"); },
    stopServer: async () => { events.push("server"); },
    closeMirror: async () => { events.push("mirror"); },
    removeScratch: async () => { events.push("scratch"); },
  };
}
test("first-page/lifecycle failure persists network evidence and remains primary after cleanup failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bw-ten-failure-"));
  let mirror: Awaited<ReturnType<typeof openRegistry>> | undefined;
  try {
    const events: string[] = [];
    const external = ["https://outside.invalid/"];
    await corpusFixture(directory);
    mirror = await openRegistry(directory, "acceptance");
    await fetch(`${mirror.base}/unrecorded`);
    await rm(join(directory, "objects", hash(JSON.stringify({ name: "control", versions: {} }))));
    await fetch(`${mirror.base}/control`);
    const registry = mirror.snapshot();
    const controller = createFinishlineRun({
      timeout: 1000, cleanupTimeout: 100, exit: () => {},
      cleanup: { ...cleanupControl(events), closeBrowser: async () => { events.push("browser"); throw new Error("browser close failed"); }, closeMirror: async () => { events.push("mirror"); await mirror?.close(); } },
      snapshot: () => networkSnapshot(mirror, external, (name, value) => writeFileSync(join(directory, name), JSON.stringify(value))),
      report: failure => writeFileSync(join(directory, "failure.json"), JSON.stringify(failure)),
    });
    expect(await controller.run(async () => { throw new Error("first page HTTP500"); })).toBe(1);
    const failure: Failure = await Bun.file(join(directory, "failure.json")).json();
    expect(failure.primary).toContain("first page HTTP500");
    expect(failure.secondary.join("\n")).toContain("browser close failed");
    expect(failure.secondary.join("\n")).toContain("replay misses/errors");
    expect(failure.unverified).toEqual(["browser close", "scratch removal"]);
    expect(await Bun.file(join(directory, "external.json")).json()).toEqual(external);
    expect(await Bun.file(join(directory, "registry.json")).json()).toEqual(registry);
    expect(events).toContain("server"); expect(events).toContain("mirror");
    expect(events).not.toContain("scratch");
  } finally { await mirror?.close(); await rm(directory, { recursive: true, force: true }); }
});
test("repeated signals during setup close owned listeners once and await late setup before scratch removal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bw-ten-signal-"));
  const signals = new EventEmitter();
  const setup = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const exited = Promise.withResolvers<void>();
  const events: string[] = [];
  let server: ReturnType<typeof Bun.serve> | undefined;
  let broker: ReturnType<typeof Bun.serve> | undefined;
  let mirror: Awaited<ReturnType<typeof openRegistry>> | undefined;
  let late = false;
  let exits = 0;
  let final: Failure | undefined;
  const controller = createFinishlineRun({
    timeout: 1000, cleanupTimeout: 200, signals,
    snapshot: () => { events.push("snapshot"); }, report: failure => { final = failure; },
    exit: () => { exits++; exited.resolve(); },
    cleanup: {
      ...cleanupControl(events),
      stopServer: async () => { events.push("server"); await server?.stop(true); await broker?.stop(true); },
      closeMirror: async () => { events.push("mirror"); await mirror?.close(); },
      removeScratch: async () => { await setup.promise; expect(await Bun.file(join(directory, "corpus/record.lock")).exists()).toBe(false); events.push("scratch"); await rm(directory, { recursive: true, force: true }); },
    },
  });
  const operation = controller.run(async () => {
    expect(signals.listenerCount("SIGTERM")).toBe(1);
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("asset") });
    broker = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("broker") });
    mirror = await openRegistry(join(directory, "corpus"), "prepare-registry");
    entered.resolve(); await setup.promise; controller.check(); late = true;
  });
  try {
    await entered.promise;
    const assetURL = `http://127.0.0.1:${server?.port}/`;
    const brokerURL = `http://127.0.0.1:${broker?.port}/`;
    expect((await fetch(assetURL)).status).toBe(200);
    expect((await fetch(brokerURL)).status).toBe(200);
    signals.emit("SIGTERM");
    expect(signals.listenerCount("SIGTERM")).toBe(1);
    signals.emit("SIGTERM"); signals.emit("SIGINT");
    expect(events).not.toContain("scratch");
    setup.resolve();
    await bounded(exited.promise, 500, "signal exit");
    expect(await operation).toBe(1);
    expect(late).toBe(false); expect(exits).toBe(1);
    expect(events.filter(name => name === "server")).toHaveLength(1);
    expect(events.filter(name => name === "browser")).toHaveLength(1);
    expect(final?.unverified).toEqual([]);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
    expect(await fetch(assetURL).then(() => true, () => false)).toBe(false);
    expect(await fetch(brokerURL).then(() => true, () => false)).toBe(false);
  } finally { setup.resolve(); await server?.stop(true); await broker?.stop(true); await rm(directory, { recursive: true, force: true }); }
});
test("overall deadline exits despite a hung capture and browser, while attempting independent stops", async () => {
  const events: string[] = [];
  const signals = new EventEmitter();
  const exited = Promise.withResolvers<void>();
  const complete = Promise.withResolvers<void>();
  let exits = 0;
  let final: Failure | undefined;
  const controller = createFinishlineRun({
    timeout: 10, cleanupTimeout: 30, signals,
    snapshot: () => { events.push("snapshot"); }, report: failure => { final = failure; },
    exit: () => { exits++; exited.resolve(); },
    cleanup: { ...cleanupControl(events), capture: () => new Promise(() => {}), closeBrowser: () => new Promise(() => {}) },
  });
  const operation = controller.run(async () => { await complete.promise; controller.check(); });
  try {
    await bounded(exited.promise, 300, "deadline exit");
    expect(exits).toBe(1);
    expect(events).toContain("server"); expect(events).toContain("mirror");
    expect(events).not.toContain("scratch");
    expect(final?.primary).toContain("Finish-line overall deadline");
    expect(final?.unverified).toContain("browser close");
    expect(final?.unverified).toContain("scratch removal");
  } finally { complete.resolve(); await operation; }
});

import { runInNewContext } from "node:vm";
import { browserRegistryRoute } from "./app-matrix/registry-request.ts";

test("actual shell fixture passes only the supported Astro opt-outs beside the existing Next opt-out", async () => {
  const source = await readFile(resolve(import.meta.dir, "../tests/shell-product/main.ts"), "utf8");
  const open = source.match(/^async function open\([\s\S]*?^}/m)?.[0];
  if (!open) throw new Error("Missing maintained shell fixture open function");
  const script = new Bun.Transpiler({ loader: "ts" }).transformSync(`let active;\n${open}`);
  const environments: unknown[] = [];
  const execute: unknown = runInNewContext(`${script}\nopen`, {
    close: async () => {}, projectFiles: () => ({}), write: async () => {},
    runtime: { filesystem: { flush: async () => {} } }, Atomics,
    SharedBridge: class { state = new Int32Array(new SharedArrayBuffer(8)); }, control: { cols: 0, rows: 1 },
    Terminal: class { async ready() {} },
    createShell: async (options: { env: unknown }) => { environments.push(structuredClone(options.env)); return {}; },
  });
  if (typeof execute !== "function") throw new Error("Fixture open must be callable");
  await execute(recipe("hono"), "http://127.0.0.1:3138");
  expect(environments).toEqual([{
    PATH: "/bin:/usr/bin", HOME: "/home/guest", PS1: "PRODUCT> ", PORT: "3137",
    NEXT_TELEMETRY_DISABLED: "1", ASTRO_TELEMETRY_DISABLED: "1", ASTRO_DISABLE_UPDATE_CHECK: "true",
  }]);
});

test("Astro opt-outs leave optional and unrelated external requests strictly blocked", async () => {
  const targets = ["https://telemetry.astro.build/api/v1/record", "https://registry.npmjs.org/astro/latest", "https://outside.invalid/"];
  const external: string[] = [];
  let aborted = 0;
  for (const target of targets) {
    await browserRegistryRoute({
      request: () => ({ url: () => target, method: () => "GET", postDataBuffer: () => null, headers: () => ({}) }),
      abort: async () => { aborted++; },
      continue: async () => { throw new Error("External request escaped guard"); },
      fetch: async () => { throw new Error("External request reached fetch"); },
      fulfill: async () => { throw new Error("External request was fulfilled"); },
    }, "http://127.0.0.1:3138", external);
  }
  expect(aborted).toBe(3);
  expect(external).toEqual(targets);
  expect(() => networkSnapshot(undefined, external, () => {})).toThrow("External requests or registry replay misses/errors");
});
