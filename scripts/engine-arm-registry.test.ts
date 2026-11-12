import { quickjsPair } from "../tests/package/quickjs-plan-fixture.ts";
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { assertBalancedRounds, childEnvironment, labelsForHost, loadArmRegistry, nativeArmLabels, parseArmRegistry, sha256, verifyArmProgram, verifyArmRegistry, verifyGzip, williamsSchedule,
  type Admission, type ArmLabel, type ArmRegistry, type FileIdentity } from "./engine-arm-registry.ts";
import { executionOutcome, nativeLauncherAdapter, nativeRegistryBuilds, parseCompilePhase, summarize } from "./bench-engines.ts";
import { parseMatrixReport, reduceArmCensus, registerArmCensus, registrySizes } from "./engine-comparison.ts";
import { censusChild, runChromiumSchedule } from "./app-matrix/engine-arms.ts";
import { censusProvenance, selectCensusArm, verifyCensusCatalog } from "./app-matrix/census-request.ts";

const source = { sourceCommit: "a".repeat(40), sourceTree: "b".repeat(40) };

async function fixture(directory: string): Promise<ArmRegistry> {
  const files: FileIdentity[] = [];
  async function file(name: string, bytes: Uint8Array): Promise<FileIdentity> {
    const path = join(directory, name);
    await writeFile(path, bytes);
    const identity = { path, bytes: bytes.length, sha256: sha256(bytes) };
    files.push(identity);
    return identity;
  }
  async function program(kind: string) {
    await mkdir(join(directory, kind));
    const names: Record<string, string> = { quickjs: "quickjs.wasm", jsc: "jsc-engine.wasm", spidermonkey: "spidermonkey-engine.wasm" };
    const core = await file(`${kind}/core.wasm`, new TextEncoder().encode(`synthetic-${kind}-core`));
    const compressedCore = await file(`${kind}/core.wasm.gz`, gzipSync(await readFile(core.path)));
    if (kind === "single") return { program: { kind, core }, servedGzip: { kind, core: compressedCore } };
    const side = await file(`${kind}/${names[kind]}`, new TextEncoder().encode(`synthetic-${kind}-side`));
    const compressedSide = await file(`${kind}/${names[kind]}.gz`, gzipSync(await readFile(side.path)));
    return { program: { kind, core, side }, servedGzip: { kind, core: compressedCore, side: compressedSide } };
  }
  const programs = await Promise.all([program("quickjs"), program("jsc"), program("spidermonkey"), program("single")]);
  const launcher = await file("synthetic-launcher", Buffer.from("not executable producer output"));
  const buildReceipt = await file("synthetic-browser-build.json", Buffer.from("{}"));
  const manifest = await file("manifest.json", Buffer.from(JSON.stringify({ schema: 1, status: "reusable", source: { head: source.sourceCommit, tree: source.sourceTree }, files: files.map(file => ({ ...file, path: file.path.slice(directory.length + 1) })) })));
  const receipt = await file("synthetic-admission.json", Buffer.from(JSON.stringify({ ...source, kind: "engine-measurement-admission", evidence: "synthetic", admitted: true, manifestSha256: manifest.sha256, files: files.slice(0, -1) })));
  const producerAdmission: Admission = { admitted: true, manifest, receipt };
  function arm(label: ArmLabel, index: number) {
    const pair = programs[index]!;
    const tier = label === "spidermonkey-interp" ? "interp" : label === "spidermonkey-pbl" ? "pbl" : null;
    const environment: Record<string, string> = tier ? { BUN_WASM_SPIDERMONKEY_TIER: tier } : {};
    return { ...source, ...pair, label, engineKind: pair.program.kind === "single" ? "browser" : pair.program.kind, tier,
      native: label !== "browser", chromium: true, environment, producerAdmission, coreSha256: pair.program.core.sha256,
      sideSha256: pair.program.side?.sha256 ?? null, guestSha256: pair.program.core.sha256, servedGzipSha256: pair.servedGzip.core.sha256 };
  }
  const nativeArms = [arm("quickjs", 0), arm("jsc", 1), arm("spidermonkey-interp", 2), arm("spidermonkey-pbl", 2)];
  const browser = arm("browser", 3);
  return parseArmRegistry({ ...source, schemaVersion: 2, evidence: "synthetic", launcher, nativeRounds: 8, chromiumRounds: 10, nativeArms, chromiumArms: nativeArms.concat([browser]),
    browserReceipt: { ...source, schemaVersion: 1, engineKind: "browser", profile: "browser-single", buildScript: "scripts/build-bun-browser.sh",
      buildReceipt, guest: browser.program.core, servedGzip: browser.servedGzip.core, producerAdmission } });
}
async function withFixture(run: (registry: ArmRegistry, directory: string) => Promise<void> | void) {
  const directory = await mkdtemp(join(tmpdir(), "bun-wasm-synthetic-arms-"));
  try { await run(await fixture(directory), directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

for (const host of ["native", "chromium"] as const) test(`${host} Williams block balances every position and directed adjacent pair`, () => {
  const labels = labelsForHost(host);
  const rows = williamsSchedule(labels);
  const repetitions = labels.length % 2 ? 2 : 1;
  expect(rows.length).toBe(labels.length * repetitions);
  for (const label of labels) for (let position = 0; position < labels.length; position++) expect(rows.filter(row => row[position] === label)).toHaveLength(repetitions);
  const pairs = rows.flatMap(row => row.slice(1).map((label, index) => `${row[index]}/${label}`));
  expect(new Set(pairs).size).toBe(labels.length * (labels.length - 1));
  for (const pair of new Set(pairs)) expect(pairs.filter(value => value === pair)).toHaveLength(repetitions);
  expect(() => assertBalancedRounds(host === "native" ? 10 : 6, labels.length)).toThrow("blocks");
});

test("synthetic receipts verify actual gzip/hash bytes but never authorize production", () => withFixture(async (registry, directory) => {
  await verifyArmRegistry(registry, { synthetic: true });
  await expect(verifyArmRegistry(registry)).rejects.toThrow("synthetic");
  const path = join(directory, "registry.json");
  await writeFile(path, JSON.stringify(registry));
  await expect(loadArmRegistry(path)).rejects.toThrow("synthetic");
  expect<readonly ArmLabel[]>(registry.nativeArms.map(arm => arm.label)).toEqual(nativeArmLabels);
  expect(registry.chromiumArms).toHaveLength(5);
}));

test("null, unadmitted, missing, retired, mixed-source and invalid identities fail closed", () => withFixture(registry => {
  expect(() => parseArmRegistry(null)).toThrow();
  const changes = [
    { sourceCommit: null }, { sourceTree: "invalid" }, { nativeRounds: 10 }, { chromiumRounds: 6 },
    { nativeArms: registry.nativeArms.slice(0, -1) },
    { chromiumArms: registry.chromiumArms.concat([registry.chromiumArms[0]!]) },
    { browserReceipt: { ...registry.browserReceipt, sourceCommit: "c".repeat(40) } },
    { browserReceipt: { ...registry.browserReceipt, producerAdmission: { ...registry.browserReceipt.producerAdmission, admitted: false } } },
  ];
  for (const change of changes) expect(() => parseArmRegistry({ ...registry, ...change })).toThrow();
  const arm = registry.nativeArms[0]!;
  for (const change of [{ label: "hermes" }, { sourceTree: "c".repeat(40) }, { coreSha256: null }, { sideSha256: "c".repeat(64) }, { producerAdmission: { ...arm.producerAdmission, admitted: false } }]) {
    expect(() => parseArmRegistry({ ...registry, nativeArms: [{ ...arm, ...change }].concat(registry.nativeArms.slice(1)) })).toThrow();
  }
}));

test("admission cannot select a sibling manifest the owning producer verifier does not read", () => withFixture(async (registry, directory) => {
  const original = registry.browserReceipt.producerAdmission;
  const path = join(directory, "alternate.json");
  await writeFile(path, await readFile(original.manifest.path));
  const proof = { ...original, manifest: { ...original.manifest, path } };
  const changed = parseArmRegistry({ ...registry,
    nativeArms: registry.nativeArms.map(arm => ({ ...arm, producerAdmission: proof })),
    chromiumArms: registry.chromiumArms.map(arm => ({ ...arm, producerAdmission: proof })),
    browserReceipt: { ...registry.browserReceipt, producerAdmission: proof },
  });
  await expect(verifyArmRegistry(changed, { synthetic: true })).rejects.toThrow("canonical producer manifest");
}));

test("a separate Browser generation stays blocked without its owning verification contract", () => withFixture((registry, directory) => {
  const original = registry.browserReceipt.producerAdmission;
  const proof = { ...original, manifest: { ...original.manifest, path: join(directory, "separate-browser/manifest.json") } };
  expect(() => parseArmRegistry({ ...registry,
    chromiumArms: registry.chromiumArms.map(arm => arm.label === "browser" ? { ...arm, producerAdmission: proof } : arm),
    browserReceipt: { ...registry.browserReceipt, producerAdmission: proof },
  })).toThrow("Browser must share the verified producer closure");
}));

test("tier identity disagreement and Browser-native claims are rejected", () => withFixture(registry => {
  const browser = registry.chromiumArms.at(-1)!;
  expect(() => parseArmRegistry({ ...registry, chromiumArms: registry.chromiumArms.slice(0, -1).concat([{ ...browser, native: true }]) })).toThrow("unavailable");
  expect(() => censusChild(browser, "native", {})).toThrow("unavailable");
  const pbl = registry.nativeArms[3]!;
  const changed = { ...pbl, program: { ...pbl.program, core: { ...pbl.program.core, path: "/different-core" } } };
  expect(() => parseArmRegistry({ ...registry, nativeArms: registry.nativeArms.slice(0, -1).concat([changed]), chromiumArms: registry.chromiumArms.slice(0, 3).concat([changed, browser]) })).toThrow("identical");
}));

test("per-child tier settings never mutate the controller or leak into the next child", () => withFixture(registry => {
  const inherited = { PATH: "/bin", BUN_WASM_SPIDERMONKEY_TIER: "pbl" };
  const builds = nativeRegistryBuilds(registry);
  const controllerTier = process.env.BUN_WASM_SPIDERMONKEY_TIER;
  const adapter = nativeLauncherAdapter("/synthetic-launcher");
  const workload = { name: "fixture", precompiled: true, args: ["-e", "0"], output: () => ({}) };
  for (const build of builds) {
    const launch = adapter.launch({ engine: build, workload, fixtureDir: "/synthetic", cacheDir: `/cache/${build.name}` });
    expect(launch.env.BUN_WASM_SPIDERMONKEY_TIER).toBe(build.arm?.tier ?? undefined);
    expect(launch.env.BUN_WASM_CACHE_DIR).toBe(`/cache/${build.name}`);
    if (build.arm?.tier) expect(launch.command).toContain(`BUN_WASM_SPIDERMONKEY_TIER=${build.arm.tier}`);
    expect(childEnvironment(build.arm!, inherited).BUN_WASM_SPIDERMONKEY_TIER).toBe(build.arm?.tier ?? undefined);
  }
  expect(inherited.BUN_WASM_SPIDERMONKEY_TIER).toBe("pbl");
  expect(process.env.BUN_WASM_SPIDERMONKEY_TIER).toBe(controllerTier);
}));

test("gzip roundtrip, changed bytes, and receipt manifests are verified, not trusted", () => withFixture(async (registry, directory) => {
  const browser = registry.browserReceipt;
  await expect(verifyGzip(browser.guest, { ...browser.servedGzip, sha256: "0".repeat(64) })).rejects.toThrow("hash");
  const bytes = gzipSync(Buffer.from("wrong raw bytes"));
  const path = join(directory, "wrong.gz");
  await writeFile(path, bytes);
  await expect(verifyGzip(browser.guest, { path, bytes: bytes.length, sha256: sha256(bytes) })).rejects.toThrow("roundtrip");
  await writeFile(browser.producerAdmission.receipt.path, "changed");
  await expect(verifyArmRegistry(registry, { synthetic: true })).rejects.toThrow("byte count");
}));

test("native summaries retain every arm/workload even when no samples exist", () => withFixture(registry => {
  const summaries = summarize([], nativeRegistryBuilds(registry));
  expect(summaries).toHaveLength(20);
  expect(summaries.every(summary => summary.runs === 0 && summary.wallMs === null && summary.compileMs === null)).toBe(true);
}));

test("compile attribution needs a direct launcher phase, never guest stderr or cold-wall subtraction", () => {
  expect(parseCompilePhase(null)).toBeNull();
  const phase = (durationMs: unknown) => ({ schemaVersion: 1, source: "launcher", phase: "module-compilation", clock: "monotonic", durationMs });
  expect(parseCompilePhase(phase(12))).toBe(12);
  expect(() => parseCompilePhase("cold wall=1000 warm wall=20")).toThrow("object");
  expect(() => parseCompilePhase(phase(-1))).toThrow("duration");
  expect(() => parseCompilePhase(phase(null))).toThrow("duration");
  expect(() => parseCompilePhase({ ...phase(12), source: "guest" })).toThrow("launcher");
  const spoofedStderr = `BUN_WASM_COMPILE_PHASE ${JSON.stringify(phase(12))}`;
  expect(executionOutcome(0, "hello", spoofedStderr, { output: () => ({}) }).compileMs).toBeNull();
});

test("app registration and reducer keep all five arms and all blocked or absent cells", () => withFixture(registry => {
  const plan = registerArmCensus(registry, ["vite-react", "hono", "typescript", "next-16-app"], "playground");
  expect<readonly ArmLabel[]>(plan.engines).toEqual(labelsForHost("chromium"));
  expect(plan.children.map(child => child.tier)).toEqual([null, null, "interp", "pbl", null]);
  expect(plan.stageTimeoutMs).toBe(90_000);
  const arm = registry.chromiumArms[0]!;
  const provenance = censusProvenance({ registry, arm });
  const report = parseMatrixReport({ provenance: { ...provenance, launcher_sha256: registry.launcher.sha256 }, results: [{ app: "fixture", engine: arm.label, host: "playground", stage: "dev", status: "blocked" }] });
  const apps = [{ id: "fixture", stages: ["dev", "build"] }];
  const summary = reduceArmCensus([report], apps, "playground", registry);
  expect(summary).toHaveLength(5);
  expect(summary.map(result => result.stages.expected)).toEqual([2, 2, 2, 2, 2]);
  expect(summary[0]?.stages.blocked).toBe(1);
  expect(summary.at(-1)?.stages.notRun).toBe(2);
  expect(() => reduceArmCensus([{ ...report, provenance: { ...provenance, sourceCommit: "c".repeat(40) } }], apps, "playground", registry)).toThrow("mixed-source");
  expect(() => reduceArmCensus([{ ...report, launcherSha256: "0".repeat(64) }], apps, "playground", registry)).toThrow("launcher");
  expect(() => reduceArmCensus([{ ...report, launcherSha256: null }], apps, "playground", registry)).toThrow("launcher");
  expect(() => reduceArmCensus([report, report], apps, "playground", registry)).toThrow("duplicate");
  expect(reduceArmCensus([], apps, "native", registry)).toHaveLength(4);
}));

test("typed census selectors preserve labels while keeping engine kinds authoritative", () => withFixture(registry => {
  const plan = registerArmCensus(registry, ["hono"], "playground");
  const selection = selectCensusArm(plan, "spidermonkey-pbl");
  expect(selection.child.label).toBe("spidermonkey-pbl");
  expect(selection.child.engine).toBe("spidermonkey");
  expect(censusProvenance(selection).armLabel).toBe("spidermonkey-pbl");
  expect(censusProvenance(selection).servedGzip).toEqual(selection.arm.servedGzip);
  expect(censusProvenance(selection).producerAdmission).toEqual(selection.arm.producerAdmission);
  expect(censusProvenance(selection).launcher_sha256).toBe(selection.registry.launcher.sha256);
  verifyCensusCatalog(selection, plan.sourceCatalog);
  expect(() => verifyCensusCatalog(selection, [])).toThrow("catalog differs");
  expect(() => selectCensusArm({ ...plan, children: plan.children.concat([plan.children[0]!]) }, "spidermonkey-pbl")).toThrow("exactly once");
  expect(() => selectCensusArm({ ...plan, sourceCatalog: [] }, "spidermonkey-pbl")).toThrow("catalog");
  expect(() => selectCensusArm({ ...plan, children: plan.children.map(child => child.label === "spidermonkey-pbl" ? { ...child, engine: "jsc" } : child) }, "spidermonkey-pbl")).toThrow("engine differs");
}));

test("Chromium schedule exercises all five arms in fresh, closed contexts and retains failures", () => withFixture(async registry => {
  const opened: string[] = [];
  const closed: string[] = [];
  let active = 0;
  const samples = await runChromiumSchedule(registry, ["ready", "hello"], {
    async open(child) {
      expect(active).toBe(0);
      opened.push(child.label);
      if (child.label === "jsc") throw new Error("synthetic setup blocked");
      active++;
      return { async measure(workload) {
        if (workload === "hello" && child.tier === "pbl") throw new Error("synthetic guest failed");
        return { wallMs: 1, compileMs: null };
      }, async close() { active--; closed.push(child.label); } };
    },
  });
  expect(opened).toHaveLength(50);
  expect(closed).toHaveLength(40);
  expect(active).toBe(0);
  expect(samples).toHaveLength(100);
  for (const label of labelsForHost("chromium")) expect(samples.filter(sample => sample.engine === label)).toHaveLength(20);
  expect(samples.filter(sample => sample.status === "blocked")).toHaveLength(20);
  expect(samples.filter(sample => sample.status === "fail")).toHaveLength(10);
}));

async function cleanupWorkload(workload: string) {
  if (workload === "bad") throw new Error("synthetic workload failed");
  return { wallMs: 2, compileMs: null };
}
async function rejectingClose(): Promise<void> { throw new Error("synthetic cleanup failed"); }
function stalledClose(): Promise<void> { return new Promise(() => undefined); }

for (const kind of ["reject", "stall"] as const) test(`Chromium ${kind} cleanup retains outcomes and blocks every unattempted cell`, () => withFixture(async registry => {
  let opens = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = runChromiumSchedule(registry, ["good", "bad"], {
    async open() { opens++; return { measure: cleanupWorkload, close: kind === "reject" ? rejectingClose : stalledClose }; },
  }, { cleanupTimeoutMs: 5 }).catch((error: unknown) => error);
  try {
    const error = await Promise.race([pending, new Promise(resolve => { timer = setTimeout(resolve, 250, "cleanup was unbounded"); })]);
    expect(error).toMatchObject({ name: "ChromiumScheduleError", cleanupError: expect.stringContaining(kind === "reject" ? "synthetic cleanup failed" : "timed out") });
    if (error === null || typeof error !== "object" || !("samples" in error) || !Array.isArray(error.samples)) throw new Error("cleanup discarded observations");
    expect(error.samples).toHaveLength(100);
    expect(error.samples[0]).toMatchObject({ workload: "good", status: "pass", wallMs: 2, compileMs: null });
    expect(error.samples[1]).toMatchObject({ workload: "bad", status: "fail", error: "Error: synthetic workload failed" });
    expect(error.samples.slice(2)).toEqual(Array(98).fill(expect.objectContaining({ status: "blocked", wallMs: null, compileMs: null })));
    expect(opens).toBe(1);
  } finally { clearTimeout(timer); }
}));

test("sizes retain the historical core/gzip/side totals schema without importing historical bytes", () => withFixture(registry => {
  const sizes = registrySizes(registry, "chromium");
  expect(sizes).toHaveLength(5);
  expect(sizes[2]?.rawBytes).toBe(sizes[3]?.rawBytes);
  expect(sizes[2]?.gzipBytes).toBe(sizes[3]?.gzipBytes);
  expect(sizes.at(-1)?.side).toBeNull();
  expect(sizes.every(row => row.guestHeap === null && row.commonCoreDeltaBytes === null && row.qualification === "synthetic-setup-only")).toBe(true);
}));

test("native execution failures and invalid outputs remain observations rather than discarded samples", () => {
  const oracle = { output: (stdout: string) => { if (stdout !== "hello") throw new Error("invalid fixture output"); return {}; } };
  expect(executionOutcome(1, "", "failed", oracle).status).toBe("fail");
  expect(executionOutcome(0, "wrong", "", oracle).status).toBe("measurement-error");
  expect(executionOutcome(0, "hello", "", oracle)).toEqual({ status: "pass", error: null, innerMs: {}, compileMs: null });
});

test("SpiderMonkey labels cannot admit otherwise valid QuickJS or JSC pairs", () => withFixture(registry => {
  for (const donor of registry.nativeArms.slice(0, 2)) {
    const sm = registry.nativeArms[2]!;
    const impostor = { ...sm, program: donor.program, servedGzip: donor.servedGzip, coreSha256: donor.coreSha256,
      sideSha256: donor.sideSha256, guestSha256: donor.guestSha256, servedGzipSha256: donor.servedGzipSha256 };
    expect(() => parseArmRegistry({ ...registry, nativeArms: registry.nativeArms.slice(0, 2).concat([impostor, registry.nativeArms[3]!]) })).toThrow("label does not match program engine");
  }
}));

test("changing a synthetic registry flag cannot turn fixture receipts into producer admission", () => withFixture(async registry => {
  const forged = parseArmRegistry({ ...registry, evidence: "producer" });
  await expect(verifyArmRegistry(forged)).rejects.toThrow("synthetic receipt");
}));

test("actual QuickJS and JSC Wasm bytes cannot pass a forged SpiderMonkey program declaration", () => withFixture(async registry => {
  const arm = registry.nativeArms[2]!;
  if (arm.program.kind === "single") throw new Error("expected paired source fixture");
  for (const kind of ["quickjs", "jsc"] as const) {
    const { core } = quickjsPair(kind);
    await writeFile(arm.program.core.path, core);
    const forged = { ...arm, program: { ...arm.program, core: { ...arm.program.core, bytes: core.length, sha256: sha256(core) } } };
    await expect(verifyArmProgram(forged)).rejects.toThrow("actual core engine profile differs");
  }
}));

test("playground requests use authoritative kinds, per-command tiers and distinct arm cache identities", () => withFixture(async registry => {
  const { playgroundCommand, playgroundURL } = await import("./engine-playground-driver.ts");
  for (const arm of registry.chromiumArms) {
    const child = censusChild(arm, "chromium", {});
    const url = new URL(playgroundURL("http://127.0.0.1/?wasm=unverified.wasm", child));
    expect(url.searchParams.get("engine")).toBe(arm.engineKind);
    expect(url.searchParams.get("measurement-arm")).toBe(arm.label);
    expect(url.searchParams.has("wasm")).toBe(false);
    const command = playgroundCommand(child, "bun hello.ts");
    expect(command).toBe(arm.tier ? `BUN_WASM_SPIDERMONKEY_TIER=${arm.tier} bun hello.ts` : "bun hello.ts");
  }
}));

test("direct host compiler spans bind source, bytes, arm and invocation and cover both modules", () => withFixture(async registry => {
  const { compileRequest, compileDuration } = await import("./engine-compile-observation.ts");
  const request = compileRequest(registry.nativeArms[0]!, "launcher", "one-sample");
  const observation = { ...request, spans: [{ part: "core", startMs: 1, endMs: 4 }, { part: "side", startMs: 2, endMs: 7 }] };
  expect(compileDuration(null, request)).toBeNull();
  expect(compileDuration(observation, request)).toBe(8);
  for (const change of [{ source: "guest" }, { runId: "other" }, { armLabel: "jsc" }, { sourceTree: "c".repeat(40) }, { program: registry.nativeArms[1]!.program }]) {
    expect(() => compileDuration({ ...observation, ...change }, request)).toThrow("differs");
  }
  expect(() => compileDuration({ ...observation, spans: observation.spans.slice(0, 1) }, request)).toThrow("every module");
  expect(() => compileDuration({ ...observation, spans: [observation.spans[0], observation.spans[0]] }, request)).toThrow("duplicate");
  expect(() => compileDuration({ ...observation, spans: [{ part: "core", startMs: 4, endMs: 1 }, observation.spans[1]] }, request)).toThrow("end");
  expect(executionOutcome(0, "hello", "", { output: () => ({}) }, JSON.stringify(observation), request).compileMs).toBe(8);
  expect(executionOutcome(0, "hello", "", { output: () => ({}) }, JSON.stringify({ ...observation, runId: "stale" }), request).status).toBe("measurement-error");
  const browser = compileRequest(registry.chromiumArms.at(-1)!, "chromium", "browser-sample");
  expect(compileDuration({ ...browser, spans: [{ part: "core", startMs: 0, endMs: 2 }] }, browser)).toBe(2);
}));

test("unconfirmed cleanup during driver.open stops before the next context and retains every outcome", () => withFixture(async registry => {
  const { HarnessCleanupError } = await import("./app-matrix/cleanup.ts");
  const { chromiumMeasurements } = await import("./engine-chromium-bench.ts");
  let opens = 0;
  const checkpoints: number[] = [];
  const result = await chromiumMeasurements(registry, ["hello"], { async open() {
    opens++;
    throw new HarnessCleanupError([{ operation: "context-open", timedOut: true, error: "synthetic close deadline" }]);
  } }, async samples => { checkpoints.push(samples.length); });
  expect(opens).toBe(1);
  expect(result.samples).toHaveLength(50);
  expect(result.samples.every(sample => sample.status === "blocked")).toBe(true);
  expect(result.cleanupError).toContain("context-open");
  expect(checkpoints).toEqual([1, 50]);
}));

test("Chromium reduction preserves missing, failed and blocked cells for every arm and rejects duplicates", () => withFixture(async registry => {
  const { reduceChromiumSamples } = await import("./engine-comparison.ts");
  const sample = { engine: registry.chromiumArms[0]!.label, round: 0, workload: "hello", status: "pass", wallMs: 3, compileMs: null, error: null } as const;
  const results = reduceChromiumSamples([sample, { ...sample, round: 1, status: "blocked", wallMs: null, error: "synthetic blocked" }], registry, ["hello"]);
  expect(results).toHaveLength(5);
  expect(results[0]).toMatchObject({ expected: 10, pass: 1, blocked: 1, notRun: 8, wallMs: { n: 1, median: 3 }, compileMs: null });
  expect(results[4]).toMatchObject({ expected: 10, pass: 0, notRun: 10, wallMs: null });
  expect(() => reduceChromiumSamples([sample, sample], registry, ["hello"])).toThrow("duplicate");
  expect(() => reduceChromiumSamples([{ ...sample, round: 10 }], registry, ["hello"])).toThrow("round");
  expect(() => reduceChromiumSamples([sample], registry, ["unknown"])).toThrow("unregistered");
}));

test("Chromium checkpoints each observed cell before waiting for context cleanup", () => withFixture(async registry => {
  const checkpoints: number[] = [];
  const result = await runChromiumSchedule(registry, ["one", "two"], { async open() {
    return { async measure() { return { wallMs: 1, compileMs: null }; }, async close() {
      expect(checkpoints.at(-1)! % 2).toBe(0);
    } };
  } }, { cleanupTimeoutMs: 10, checkpoint: async samples => { checkpoints.push(samples.length); } });
  expect(result).toHaveLength(100);
  expect(checkpoints.slice(0, 3)).toEqual([1, 2, 2]);
}));

test("an interrupted Chromium schedule blocks remaining contexts instead of reopening after teardown", () => withFixture(async registry => {
  const controller = new AbortController();
  let opens = 0;
  const samples = await runChromiumSchedule(registry, ["hello"], { async open() {
    opens++;
    return { async measure() { controller.abort("synthetic interrupt"); return { wallMs: 1, compileMs: null }; }, async close() {} };
  } }, { cleanupTimeoutMs: 10, signal: controller.signal });
  expect(opens).toBe(1);
  expect(samples).toHaveLength(50);
  expect(samples[0]?.status).toBe("pass");
  expect(samples.slice(1).every(sample => sample.status === "blocked" && sample.error?.includes("synthetic interrupt"))).toBe(true);
}));

test("census integration consumes the typed request at both host selectors and strips host-only observer values", async () => {
  const [runner, browser, launcher, nativeObserver] = await Promise.all([
    readFile(new URL("./app-matrix/run.mjs", import.meta.url), "utf8"),
    readFile(new URL("./app-matrix/browser.mjs", import.meta.url), "utf8"),
    readFile(new URL("../crates/bunwasm-host/src/main.rs", import.meta.url), "utf8"),
    readFile(new URL("../crates/bunwasm-host/src/compile_observation.rs", import.meta.url), "utf8"),
  ]);
  expect(runner).toContain("censusSelection?.registry.launcher.path");
  expect(runner).toContain("Object.entries(censusSelection.child.environment)");
  expect(runner).toContain("measurement: censusSelection?.child");
  expect(runner).toContain("verifyCensusCatalog(censusSelection, selected)");
  expect(browser).toContain("measurementURL(base, measurement)");
  expect(browser).toContain("await verifyServed(page)");
  expect(launcher).toContain("!compile_observation::host_only(name)");
  expect(nativeObserver).toContain('fs::write(&request.path, b"null\\n")');
  expect(nativeObserver).not.toContain("Instant::now");
});
