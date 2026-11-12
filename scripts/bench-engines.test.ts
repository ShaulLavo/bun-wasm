import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { quickjsPair } from "../tests/package/quickjs-plan-fixture";
import { programProfile } from "../src/engine-kind";
import { expect, test } from "bun:test";
import { distribution, engineArtifacts, engineOrder, median, nativeControlAdapter, parseEngineSpecs, parseMicroOutput } from "./bench-engines";

test("micro parser checks every section and checksum", () => {
  const output = [
    "loop 10 ms (1534387362)",
    "regexp 11 ms (1431980)",
    "json 12 ms (4924030)",
    "alloc 13 ms (1400000)",
    "strings 14 ms (98799)",
  ].join("\n");
  expect(parseMicroOutput(output)).toEqual({ loop: 10, regexp: 11, json: 12, alloc: 13, strings: 14 });
  expect(() => parseMicroOutput(output.replace("1534387362", "0"))).toThrow("loop checksum");
});

test("median handles odd and even sample counts", () => {
  expect(median([9, 1, 5])).toBe(5);
  expect(median([9, 1, 5, 3])).toBe(4);
});

test("engine order alternates without mutating the input", () => {
  const engines = parseEngineSpecs(["quickjs=dist/bun.wasm", "jsc=dist/bun-jsc.wasm"]);
  expect(engineOrder(engines, 0).map(engine => engine.name)).toEqual(["quickjs", "jsc"]);
  expect(engineOrder(engines, 1).map(engine => engine.name)).toEqual(["jsc", "quickjs"]);
  expect(engines.map(engine => engine.name)).toEqual(["quickjs", "jsc"]);
  expect(() => parseEngineSpecs(["same=a.wasm", "same=b.wasm"])).toThrow("unique");
});

test("six rounds counterbalance all three positions and directed adjacent pairs", () => {
  const engines = parseEngineSpecs(["quickjs=q.wasm", "jsc=j.wasm", "third=t.wasm"]);
  const orders = Array.from({ length: 6 }, (_, round) => engineOrder(engines, round).map(engine => engine.name));
  expect(new Set(orders.map(order => order.join(","))).size).toBe(6);
  for (const engine of engines) for (let position = 0; position < 3; position++) expect(orders.filter(order => order[position] === engine.name)).toHaveLength(2);
  const pairs = orders.flatMap(order => order.slice(0, -1).map((name, index) => `${name}/${order[index + 1]}`));
  expect(new Set(pairs).size).toBe(6);
  for (const pair of new Set(pairs)) expect(pairs.filter(value => value === pair)).toHaveLength(2);
  expect(engineOrder(engines, 6)).toEqual(engineOrder(engines, 0));
});

test("distributions retain noisy valid samples and use nearest-rank p90", () => {
  const values = [100, 1, 4, 3, 2, 5];
  expect(distribution(values)).toEqual({ n: 6, min: 1, median: 3.5, p90: 100, max: 100, mad: 1.5, flags: ["relative-mad-above-10-percent"] });
  expect(values[0]).toBe(100);
  expect(distribution([0])?.flags).toEqual(["fewer-than-six"]);
  expect(distribution([])).toBeNull();
  expect(() => distribution([NaN])).toThrow("finite");
});

test("native control runs real fixture bytes without any Wasm or engine label", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bun-wasm-native-control-"));
  try {
    await writeFile(join(directory, "hello.ts"), 'const message: string = "control-ok"; console.log(message);');
    const request = { engine: { name: "native-bun-control", path: process.execPath }, fixtureDir: directory,
      workload: { name: "hello-cold", precompiled: false, args: ["run", "/hello.ts"], output: () => ({}) } };
    const launch = nativeControlAdapter(process.execPath).launch(request);
    const child = Bun.spawnSync({ cmd: launch.command, env: launch.env });
    expect(child.exitCode).toBe(0);
    expect(child.stdout.toString().trim()).toBe("control-ok");
    expect(launch.command).not.toContain("--wasm");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("an existing output identity is rejected without overwriting evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bun-wasm-bench-output-"));
  try {
    const output = join(directory, "result.json");
    await writeFile(output, "retained-evidence");
    const child = Bun.spawnSync([process.execPath, join(import.meta.dirname, "bench-engines.ts"), "--native-control", "--runs", "1", "--output", output]);
    expect(child.exitCode).toBe(1);
    expect(await Bun.file(output).text()).toBe("retained-evidence");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

for (const kind of ["quickjs", "jsc"] as const) test(`${kind} metadata records both actual artifact identities`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "bun-wasm-pair-metadata-"));
  try {
    const { core, side } = quickjsPair(kind);
    const profile = programProfile(kind);
    const path = join(directory, profile.core);
    await writeFile(path, core);
    await writeFile(join(directory, profile.side), side);
    const metadata = await engineArtifacts(path);
    if (metadata.kind === "single") throw new Error("Expected pair metadata");
    expect(metadata.kind).toBe(kind);
    expect(metadata.core.bytes + metadata.side.bytes).toBe(core.length + side.length);
    expect(metadata.side.path).toBe(join(directory, profile.side));
    expect(metadata.side.sha256).toBe(new Bun.CryptoHasher("sha256").update(side).digest("hex"));
    await rm(join(directory, profile.side));
    await expect(engineArtifacts(path)).rejects.toThrow(profile.side);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

for (const args of [
  ["--host", "chromium"],
  ["--host", "unexpected"],
  ["--native-control", "--url", "http://127.0.0.1/"],
]) test(`measurement CLI refuses incomplete or cross-host arguments ${args.join(" ")}`, () => {
  const child = Bun.spawnSync([process.execPath, join(import.meta.dirname, "bench-engines.ts")].concat(args));
  expect(child.exitCode).toBe(1);
  expect(child.stderr.toString()).toMatch(/requires|must be/);
});

test.skipIf(process.env.BUN_WASM_MEASUREMENT_BROWSER_FIXTURE !== "1")("real Chromium uses existing playground controls against a tiny synthetic page, not engine acceptance", async () => {
  const { chromium } = await import("playwright");
  const { ready, run, writeFile: writeGuestFile } = await import("../web/tests/playground.mjs");
  const { closeOwnedBrowser } = await import("./app-matrix/cleanup.ts");
  const { playgroundChromiumDriver, playgroundCompileObserver } = await import("./engine-playground-driver.ts");
  const { sha256 } = await import("./engine-arm-registry.ts");
  const { gzipSync } = await import("node:zlib");
  const core = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
  const gzip = gzipSync(core);
  const identity = { path: "/synthetic-fixture/bun-browser.wasm", bytes: core.length, sha256: sha256(core) };
  const compressed = { path: `${identity.path}.gz`, bytes: gzip.length, sha256: sha256(gzip) };
  const admission = { admitted: true, manifest: identity, receipt: identity } as const;
  const child = { label: "browser", engine: "browser", tier: null, cacheIdentity: "browser", environment: {},
    sourceCommit: "a".repeat(40), sourceTree: "b".repeat(40), program: { kind: "single", core: identity },
    servedGzip: { kind: "single", core: compressed }, producerAdmission: admission } as const;
  const html = `<!doctype html><div id="status">loading</div><script type="module">
    globalThis.__bunwasmBuilds = ${JSON.stringify({ "bun-browser.wasm": identity.sha256 })};
    await fetch('./bun-browser.wasm.gz').then(response => response.arrayBuffer());
    const lines = ['$ '];
    globalThis.playground = {
      fs: { async writeFile(path, text) { globalThis.lastFixtureFile = { path, text }; } },
      shell: { running: false, lastExit: 0, async submit(command) {
        lines[lines.length - 1] += command;
        this.lastExit = command.includes('fail') ? 1 : 0;
        lines.push(this.lastExit ? 'synthetic failure' : 'hello', '$ ');
      } },
      term: { write(text, callback) { callback(); }, buffer: { active: {
        get length() { return lines.length; }, getLine(index) { return { translateToString() { return lines[index]; } }; }
      } } }
    };
    document.querySelector('#status').textContent = 'ready';
  </script>`;
  let corrupt = false;
  const fixture = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    if (new URL(request.url).pathname === "/bun-browser.wasm.gz") return new Response(corrupt ? Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8) : gzip);
    return new Response(html, { headers: { "content-type": "text/html" } });
  } });
  let server: Awaited<ReturnType<typeof chromium.launchServer>> | undefined;
  try {
    server = await chromium.launchServer({ headless: true, timeout: 5_000 });
    const browser = await chromium.connect(server.wsEndpoint());
    const driver = playgroundChromiumDriver({ browser, url: fixture.url.href, controls: { ready, run, writeFile: writeGuestFile }, timeoutMs: 5_000, cleanupTimeoutMs: 1_000, compileObserver: playgroundCompileObserver,
      workloads: [{ name: "hello", files: { "/home/user/hello.ts": "synthetic fixture" }, command: "bun hello.ts", check(stdout) { expect(stdout).toBe("hello"); } },
        { name: "failure", files: {}, command: "bun fail", check() { throw new Error("must not reach oracle"); } }] });
    const context = await driver.open(child);
    try {
      expect((await context.measure("engine-ready")).compileMs).toBeNull();
      expect(await context.measure("hello")).toMatchObject({ wallMs: expect.any(Number), compileMs: null });
      await expect(context.measure("failure")).rejects.toThrow("guest exit 1");
    } finally { await context.close(); }
    expect(browser.contexts()).toHaveLength(0);
    corrupt = true;
    await expect(driver.open(child)).rejects.toThrow("differs");
    expect(browser.contexts()).toHaveLength(0);
  } finally {
    try { if (server) await closeOwnedBrowser(server, 1_000); }
    finally { await fixture.stop(true); }
  }
  const childProcess = server?.process();
  expect(childProcess?.exitCode !== null || childProcess?.signalCode !== null).toBe(true);
  let alive = false;
  try { if (childProcess?.pid) { process.kill(childProcess.pid, 0); alive = true; } }
  catch (error) { if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error; }
  expect(alive).toBe(false);
  if (process.env.BUN_WASM_MEASUREMENT_CLEANUP_RECEIPT) await Bun.write(process.env.BUN_WASM_MEASUREMENT_CLEANUP_RECEIPT,
    JSON.stringify({ syntheticOnly: true, pid: childProcess?.pid, alive, exitCode: childProcess?.exitCode, signal: childProcess?.signalCode, fixtureUrl: fixture.url.href, serverStopped: true }) + "\n");
}, 30_000);

test("native warm-cache blockers retain cells without fabricating zero timings or suppressing the next arm", async () => {
  const { nativeMeasurementCell, summarize } = await import("./bench-engines.ts");
  const directory = await mkdtemp(join(tmpdir(), "bun-wasm-native-cell-"));
  try {
    await writeFile(join(directory, "hello.ts"), 'console.log("hello");');
    const workload = { name: "hello-precompiled", precompiled: true, args: ["run", "/hello.ts"], output(stdout: string) {
      expect(stdout.trim()).toBe("hello"); return {};
    } };
    const engines = [{ name: "blocked-fixture", path: process.execPath }, { name: "tiny-native-control", path: process.execPath }];
    const adapter = nativeControlAdapter(process.execPath);
    const first = nativeMeasurementCell(adapter, { engine: engines[0]!, workload, fixtureDir: directory }, 0, "synthetic warmup blocked");
    const second = nativeMeasurementCell(adapter, { engine: engines[1]!, workload, fixtureDir: directory }, 0);
    expect(first).toMatchObject({ status: "blocked", wallMs: null, peakRssBytes: null, compileMs: null });
    expect(second.status).toBe("pass");
    const summaries = summarize([first, second], engines, 8).filter(row => row.workload === workload.name);
    expect(summaries[0]).toMatchObject({ expected: 8, runs: 1, blocked: 1, notRun: 7, wallMs: null });
    expect(summaries[1]).toMatchObject({ expected: 8, pass: 1, blocked: 0, notRun: 7 });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
