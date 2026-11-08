import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { spawnSync } from "node:child_process";
import { markStarted } from "waffle/proc/outcome";
import { workerProcessState, type WorkerProcessMessage } from "waffle/proc/worker-client";
import { prepareProgram, programLinkPlan } from "../src/assets.ts";
import { pairedEngines, pairedEngineKinds, isSupportedPairedEngine, isPairedEngine, parseProgramFiles, programKind, programProfile, verifyProgramSide } from "../src/engine-kind.ts";
import { quickjsPair } from "../tests/package/quickjs-plan-fixture.ts";
import { linkNodeProgram, loadNodeProgram } from "../web/scripts/node-linked.ts";
import { NodeProcessBroker } from "../web/scripts/node-spawn.ts";
import { createNodeProcess } from "../web/scripts/node-process.ts";
import { createMemoryReader, recordMemorySnapshot } from "../web/src/memory-telemetry.ts";
import { engineEnvironment } from "../src/executable-paths.ts";
import { isEngine, loadWasm, WasmMissing } from "../web/src/engine-loader.ts";

const kind = "spidermonkey";

async function withPair(run: (path: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "bun-wasm-spidermonkey-host-"));
  try {
    const pair = quickjsPair(kind);
    writeFileSync(join(root, programProfile(kind).core), pair.core);
    writeFileSync(join(root, programProfile(kind).side), pair.side);
    await run(root);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

async function initializedValue(source: NonNullable<ReturnType<typeof programLinkPlan>>) {
  const linked = await linkNodeProgram(source, { runtime_proc: { signal: () => 0 } });
  try {
    const value = linked.entry.exports.value;
    if (typeof value !== "function") throw new Error("Fixture value export missing");
    expect(value()).toBe(0);
    linked.initialize();
    return value();
  } finally { linked.dispose(); }
}

test("SpiderMonkey package preparation links and initializes the actual tiny pair", async () => {
  const files = parseProgramFiles({ kind, ...quickjsPair(kind) }, value => {
    if (!(value instanceof Uint8Array)) throw new TypeError("Fixture bytes required");
    return value;
  });
  const module = await prepareProgram(files);
  expect(programKind(module)).toBe(kind);
  const source = programLinkPlan(module);
  if (!source) throw new Error("Paired program lost its link plan");
  expect(source.libraries.map(library => library.id)).toEqual([kind]);
  expect(await initializedValue(source)).toBe(42);
});

test("Node's SpiderMonkey loader finds the named companion and executes its initialization", async () => {
  await withPair(async root => {
    const program = await loadNodeProgram(join(root, programProfile(kind).core), kind);
    expect(programKind(program.module)).toBe(kind);
    if (!program.linkPlan) throw new Error("Node loader lost the paired link plan");
    expect(await initializedValue(program.linkPlan)).toBe(42);
  });
});

test("SpiderMonkey refuses another core, a missing side, and a mismatched side", async () => {
  await withPair(async root => {
    const path = join(root, programProfile(kind).core);
    await expect(loadNodeProgram(path, "quickjs")).rejects.toThrow("Selected quickjs core declares spidermonkey");
    rmSync(join(root, programProfile(kind).side));
    await expect(loadNodeProgram(path, kind)).rejects.toThrow("spidermonkey-engine.wasm");
    writeFileSync(join(root, programProfile(kind).side), quickjsPair("jsc").side);
    await expect(loadNodeProgram(path, kind)).rejects.toThrow("Invalid spidermonkey companion");
  });
});

test("Node engine-qualified child paths select SpiderMonkey without replacing /bin/bun", async () => {
  const browser = new WebAssembly.Module(Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0));
  const module = await prepareProgram({ kind, ...quickjsPair(kind) });
  const broker = new NodeProcessBroker({ module: browser, engines: { spidermonkey: module }, launch() { throw new Error("unexpected launch"); } });
  try {
    expect((await broker.registry.resolve("/bin/bun")).module).toBe(browser);
    for (const command of ["bun", "node", "nodejs"]) {
      expect((await broker.registry.resolve(`/opt/bun/spidermonkey/bin/${command}`)).module).toBe(module);
    }
    await expect(broker.registry.resolve("/opt/bun/jsc/bin/bun")).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await broker.dispose(); }
});

async function withBrowserPair(run: (requests: string[]) => Promise<void>, options: { side?: boolean; corrupt?: "core" | "side"; missingFingerprint?: "core" | "side" } = {}) {
  const pair = quickjsPair(kind);
  const original = new Map<string, PropertyDescriptor | undefined>();
  const requests: string[] = [];
  const files = new Map([["/bun-spidermonkey.wasm", pair.core]]);
  if (options.side !== false) files.set("/spidermonkey-engine.wasm", pair.side);
  files.set("/custom-sm.wasm", pair.core);
  const builds = Object.fromEntries(Array.from(files, ([path, bytes]) => [path.slice(1), new Bun.CryptoHasher("sha256").update(bytes).digest("hex")]));
  // Include the expected identity even when the server lacks the companion.
  builds["spidermonkey-engine.wasm"] ??= new Bun.CryptoHasher("sha256").update(pair.side).digest("hex");
  if (options.corrupt) files.set(options.corrupt === "core" ? "/bun-spidermonkey.wasm" : "/spidermonkey-engine.wasm", Uint8Array.of(0));
  if (options.missingFingerprint) delete builds[options.missingFingerprint === "core" ? "bun-spidermonkey.wasm" : "spidermonkey-engine.wasm"];
  const fetchFile = Object.assign(async (input: Parameters<typeof fetch>[0]) => {
    const path = new URL(String(input)).pathname;
    requests.push(path);
    const bytes = files.get(path);
    return bytes ? new Response(bytes, { headers: { "content-type": "application/wasm" } }) : new Response(null, { status: 404 });
  }, { preconnect: fetch.preconnect });
  const globals = { location: new URL("https://spidermonkey.test/"), __bunwasmBuilds: builds, fetch: fetchFile, caches: undefined };
  for (const [key, value] of Object.entries(globals)) {
    original.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  try { await run(requests); }
  finally {
    for (const [key, descriptor] of original) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

test("browser selection admits only the engine kind, not the interpreter tier label", () => {
  expect(isEngine(kind)).toBe(true);
  expect(isEngine("spidermonkey-pbl")).toBe(false);
  expect(isEngine("spidermonkey-interp")).toBe(false);
  for (const engine of ["quickjs", "jsc", "browser"]) expect(isEngine(engine)).toBe(true);
});

test("browser loader verifies both SpiderMonkey files and preserves the executable pair", async () => {
  await withBrowserPair(async requests => {
    const loaded = await loadWasm("https://spidermonkey.test/bun-spidermonkey.wasm", () => {});
    expect(programKind(loaded.module)).toBe(kind);
    expect(loaded.build).not.toBeNull();
    const pair = quickjsPair(kind);
    expect(loaded.size).toBe(pair.core.length + pair.side.length);
    const source = programLinkPlan(loaded.module);
    if (!source) throw new Error("Browser loader lost the paired link plan");
    expect(await initializedValue(source)).toBe(42);
    expect(requests).toEqual(["/bun-spidermonkey.wasm.gz", "/bun-spidermonkey.wasm", "/spidermonkey-engine.wasm.gz", "/spidermonkey-engine.wasm"]);
  });
});

test("browser loader reports a missing SpiderMonkey companion rather than falling back", async () => {
  await withBrowserPair(async () => {
    const error = await loadWasm("https://spidermonkey.test/bun-spidermonkey.wasm", () => {}).catch(error => error);
    expect(error).toBeInstanceOf(WasmMissing);
    expect(String(error)).toContain("spidermonkey-engine.wasm: HTTP 404");
  }, { side: false });
});


test("Node concurrent SpiderMonkey children keep separate tiers on one paired module", async () => {
  const files = { kind, ...quickjsPair(kind) } as const;
  const module = await prepareProgram(files);
  const observed: unknown[] = [], errors: unknown[] = [];
  const messages: WorkerProcessMessage[] = [];
  const ambient = process.env.BUN_WASM_SPIDERMONKEY_TIER;
  const broker = new NodeProcessBroker({ module, engines: { spidermonkey: module },
    onError: error => errors.push(error),
    launch(context, transport) {
      expect(context.module).toBe(module);
      markStarted(workerProcessState(transport).signals.outcome);
      const worker = new Worker(new URL("../web/tests/fixtures/spidermonkey-tier-worker.ts", import.meta.url), {
        workerData: { module: context.module, files, env: context.request.env },
      });
      worker.on("message", message => observed.push(message));
      return worker;
    },
  });
  const host = createNodeProcess({ transport: broker.root,
    postMessage: message => messages.push(structuredClone(message)),
    finish(): never { throw new Error("unexpected root exit"); },
  });
  try {
    const children = ["interp", "pbl"].map(tier => host.client.spawn(host.client.pid, {
      executable: "/opt/bun/spidermonkey/bin/bun", argv: ["bun"], cwd: "/", job: 0, fds: [],
      env: { BUN_WASM_SPIDERMONKEY_TIER: tier },
    }));
    await Promise.all(messages.splice(0).map(message => broker.broker.handle(message, host.client.pid)));
    const results = await Promise.all(children.map(pid => broker.supervisor.waitForExit(host.client.pid, pid)));
    expect(results.map(result => result.status)).toEqual([0, 0]);
    expect(observed).toHaveLength(2);
    expect(observed).toContainEqual({ tier: "interp", kind, value: 42 });
    expect(observed).toContainEqual({ tier: "pbl", kind, value: 42 });
    expect(errors).toEqual([]);
    expect(process.env.BUN_WASM_SPIDERMONKEY_TIER).toBe(ambient);
  } finally { host.dispose(); await broker.dispose(); }
});


test("Node CLI executes a tiny paired core and validates every explicit engine path", async () => {
  await withPair(async root => {
    const core = join(root, programProfile(kind).core);
    const args = ["--disable-warning=ExperimentalWarning", new URL("../web/scripts/node-host.ts", import.meta.url).pathname, "--wasm", core];
    const options = { encoding: "utf8", timeout: 10_000, env: { ...process.env, BUN_WASM_SCRATCH_ROOT: root } } as const;
    const baseline = spawnSync("node", args, options);
    expect(baseline.error).toBeUndefined();
    expect(baseline.status, baseline.stderr).toBe(0);
    const configured = spawnSync("node", args.concat(["--engine", `spidermonkey=${core}`]), options);
    expect(configured.error).toBeUndefined();
    expect(configured.status, configured.stderr).toBe(0);
    const missing = join(root, "missing-spidermonkey.wasm");
    const explicit = spawnSync("node", args.concat(["--engine", `spidermonkey=${missing}`]), options);
    expect(explicit.error).toBeUndefined();
    expect(explicit.status).not.toBe(0);
    expect(explicit.stderr).toContain("missing-spidermonkey.wasm");
  });
});


for (const corrupt of ["core", "side"] as const) test(`browser rejects changed SpiderMonkey ${corrupt} bytes before linking`, async () => {
  await withBrowserPair(async () => {
    await expect(loadWasm("https://spidermonkey.test/bun-spidermonkey.wasm", () => {})).rejects.toThrow("integrity mismatch");
  }, { corrupt });
});

for (const missingFingerprint of ["core", "side"] as const) test(`browser requires the SpiderMonkey ${missingFingerprint} fingerprint`, async () => {
  await withBrowserPair(async () => {
    await expect(loadWasm("https://spidermonkey.test/bun-spidermonkey.wasm", () => {})).rejects.toThrow("build manifest fingerprint is missing");
  }, { missingFingerprint });
});

test("SpiderMonkey metadata does not expand normal publication or introduce tier kinds", () => {
  expect(pairedEngines).toEqual(["quickjs", "jsc"]);
  expect(pairedEngineKinds).toEqual(["quickjs", "jsc", kind]);
  expect(isSupportedPairedEngine(kind)).toBe(false);
  expect(isPairedEngine(kind)).toBe(true);
  const env = { PATH: "/bin:/usr/bin", BUN_WASM_SPIDERMONKEY_TIER: "pbl" };
  const selected = engineEnvironment(kind, env);
  expect(selected).toEqual({ PATH: "/opt/bun/spidermonkey/bin:/bin:/usr/bin", BUN_WASM_SPIDERMONKEY_TIER: "pbl" });
  expect(env.PATH).toBe("/bin:/usr/bin");
  expect(engineEnvironment(kind, selected)).toEqual(selected);
});

test("SpiderMonkey declarations cannot borrow QuickJS or JSC companion profiles", async () => {
  const sm = quickjsPair(kind);
  for (const other of pairedEngines) {
    const pair = quickjsPair(other);
    await expect(prepareProgram({ kind, core: pair.core, side: sm.side })).rejects.toThrow("does not match core declaration");
    await expect(prepareProgram({ kind, core: sm.core, side: pair.side })).rejects.toThrow("Invalid spidermonkey companion");
    expect(() => verifyProgramSide(other, new WebAssembly.Module(sm.side))).toThrow("initializer/RUN");
  }
  expect(() => parseProgramFiles({ kind, core: sm.core }, value => value)).toThrow("companion fields");
});

test("SpiderMonkey telemetry admits snapshots without inventing counters or calling an unknown refresh export", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const reader = createMemoryReader(kind, { exports: { memory } }, { exports: {
    spidermonkey_memory_telemetry_refresh() { throw new Error("Unknown ABI must not be refreshed"); },
  } }, null);
  const snapshot = reader.sample(true);
  expect(recordMemorySnapshot({ type: "bun-memory", snapshot })).toBe(true);
  expect(snapshot).toMatchObject({ engine: kind, wasmCapacityBytes: 65536, memoryLimitBytes: null,
    jsHeapBytes: null, arrayBufferBytes: null, swcBytes: null, allocatorLiveBytes: null, allocatorPeakBytes: null,
    failedAllocation: null, engineFailure: null, engineCounters: {} });
  expect(reader.finish().terminal).toBe(true);
});

async function stageSpiderMonkey(env: Record<string, string>, missing?: string): Promise<string[]> {
  const source = readFileSync(new URL("../web/build.ts", import.meta.url), "utf8");
  const start = source.indexOf('if (!(await copyWasm(wasmSource, "bun.wasm")))');
  const end = source.indexOf("await buildShellAssets", start);
  if (start < 0 || end < 0) throw new Error("Missing web guest staging boundary");
  const stage = new Function("copyWasm", "existsSync", "resolve", "join", "dirname", "here", "process", "wasmSource", `return (async () => {${source.slice(start, end)}})();`);
  const names: string[] = [];
  await stage(async (path: string, name: string) => {
    names.push(name);
    if (path === missing) return false;
    return true;
  }, () => true, resolve, join, dirname, "/synthetic/web", { env }, "/synthetic/bun.wasm");
  return names;
}

test("web staging copies SpiderMonkey only on explicit opt-in and requires both files", async () => {
  expect(await stageSpiderMonkey({})).not.toContain("bun-spidermonkey.wasm");
  expect(await stageSpiderMonkey({ SPIDERMONKEY_WASM: "/explicit/bun-spidermonkey.wasm" })).toContain("spidermonkey-engine.wasm");
  await expect(stageSpiderMonkey({ SPIDERMONKEY_WASM: "/explicit/bun-spidermonkey.wasm" }, "/explicit/spidermonkey-engine.wasm")).rejects.toThrow("/explicit/spidermonkey-engine.wasm");
  await expect(stageSpiderMonkey({ SPIDERMONKEY_WASM: "/explicit/missing.wasm" }, "/explicit/missing.wasm")).rejects.toThrow("SpiderMonkey core is missing");
});

test("Node verifies the tiny asset pair and runs concurrent engine-qualified children", async () => {
  await withPair(async root => {
    const fixture = new URL("../web/tests/fixtures/spidermonkey-node-host.ts", import.meta.url).pathname;
    const result = spawnSync("node", ["--disable-warning=ExperimentalWarning", fixture, root], {
      encoding: "utf8", timeout: 10_000, env: { ...process.env, BUN_WASM_SCRATCH_ROOT: root },
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const value: unknown = JSON.parse(result.stdout);
    if (!value || typeof value !== "object" || !("observed" in value)) throw new Error("Invalid Node fixture output");
    expect(value).toMatchObject({ hostValue: 42, statuses: [0, 0], errors: [], environmentUnchanged: true });
    expect(value.observed).toContainEqual({ kind, tier: "interp", value: 42 });
    expect(value.observed).toContainEqual({ kind, tier: "pbl", value: 42 });
  });
});


for (const missingFingerprint of [undefined, "core", "side"] as const) test(`custom SpiderMonkey core URLs cannot bypass pair fingerprints (${missingFingerprint ?? "verified"})`, async () => {
  await withBrowserPair(async () => {
    const loaded = loadWasm("https://spidermonkey.test/custom-sm.wasm", () => {});
    if (missingFingerprint) {
      await expect(loaded).rejects.toThrow("build manifest fingerprint is missing");
      return;
    }
    const source = programLinkPlan((await loaded).module);
    if (!source) throw new Error("Custom URL lost its link plan");
    expect(await initializedValue(source)).toBe(42);
    expect((await loaded).build).not.toBeNull();
  }, { missingFingerprint });
});

test("the actual optional web staging hashes and compresses both tiny SpiderMonkey files", async () => {
  await withPair(async root => {
    const out = join(root, "out");
    mkdirSync(out);
    const source = readFileSync(new URL("../web/build.ts", import.meta.url), "utf8");
    const start = source.indexOf("const engineBuilds:");
    const end = source.indexOf("await buildShellAssets", start);
    if (start < 0 || end < 0) throw new Error("Missing web asset copy boundary");
    const code = new Bun.Transpiler({ loader: "ts" }).transformSync(source.slice(start, end));
    const stage = new Function("Bun", "existsSync", "join", "dirname", "resolve", "statSync", "out", "here", "process", "wasmSource", `return (async () => {${code}; return engineBuilds;})();`);
    const builds = await stage(Bun, existsSync, join, dirname, resolve, statSync, out, root, {
      env: { SPIDERMONKEY_WASM: join(root, programProfile(kind).core) },
    }, join(root, "missing-quickjs.wasm"));
    expect(Object.keys(builds).sort()).toEqual(["bun-spidermonkey.wasm", "spidermonkey-engine.wasm"]);
    for (const name of [programProfile(kind).core, programProfile(kind).side]) {
      const raw = readFileSync(join(root, name));
      expect(builds[name]).toBe(new Bun.CryptoHasher("sha256").update(raw).digest("hex"));
      expect(Bun.gunzipSync(readFileSync(join(out, `${name}.gz`)))).toEqual(raw);
    }
  });
});


test("an unconfigured SpiderMonkey executable never falls back to the Node base module", async () => {
  const base = new WebAssembly.Module(Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0));
  const broker = new NodeProcessBroker({ module: base, launch() { throw new Error("Unexpected launch"); } });
  try {
    expect((await broker.registry.resolve("/bin/bun")).module).toBe(base);
    for (const command of ["bun", "node", "nodejs"]) {
      await expect(broker.registry.resolve(`/opt/bun/spidermonkey/bin/${command}`)).rejects.toMatchObject({ code: "ENOENT" });
    }
  } finally { await broker.dispose(); }
});
