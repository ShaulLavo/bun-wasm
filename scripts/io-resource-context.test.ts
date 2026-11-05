// Host-only checks of the live driver: argument boundary, row evaluation and the stdin gate with
// cleanup. Nothing here runs a guest engine, so no result counts as an engine pass.
import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RESULT_SCHEMA, buildFiveOwnerResult, evaluateRow, main, parseGuestResult, parseInvocation, type FiveOwnerResult, type Invocation, type RowRun } from "./io-resource-context.ts";
import { rowIds, rows, type Observation, type RowId } from "../tests/fixtures/io-resource-context/rows.ts";
import { parseRowOutput } from "../tests/fixtures/io-resource-context/protocol.ts";
import { isLoadedAsset, loadedObserver } from "./io-resource-context-assets.ts";
import { hostDeadline, runGroup } from "./io-resource-context.ts";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { writeContractFixture } from "./c1/contract-fixture.ts";
import { fileIdentity } from "./c1/identity.ts";
import { bindFiveOwnerOutput, bindFiveOwnerSource, readFiveOwnerHandoff, readFiveOwnerMember, recheckFiveOwnerBrowser, recheckFiveOwnerHandoff, requireFiveOwnerMember, requireFiveOwnerResponse } from "./io-resource-context-intake.ts";
import { bindLoaded, parseLoaded } from "./c1/loaded.ts";
import { qualificationFixture } from "./tls-qualification-fixture.ts";

function run(id: RowId, records: Observation[], extra: Partial<RowRun> & { armed?: boolean; settled?: number } = {}): RowRun {
  const report = { id, records, settled: extra.settled ?? records.length, armed: extra.armed ?? null, error: null, execPath: "/bin/bun" };
  return { id, exitCode: 0, timedOut: false, report, stderr: "", ...extra };
}

test("artifacts are explicit: no guest, launcher or web root is ever defaulted", () => {
  expect(() => parseInvocation(["--surface", "native", "--engine", "quickjs", "--out", "/tmp/x"])).toThrow("--guest is required");
  expect(() => parseInvocation(["--surface", "chromium", "--out", "/tmp/x"])).toThrow("--web-root is required");
  expect(() => parseInvocation(["--surface", "native", "--engine", "hermes", "--out", "/tmp/x"])).toThrow("--engine must be quickjs or jsc");
});

test("controls cannot qualify, and unknown rows or options are rejected", () => {
  expect(() => parseInvocation(["--surface", "host-bun", "--out", "/tmp/x", "--handoff", "/unused", "--handoff-sha256", "a".repeat(64)])).toThrow("cannot qualify");
  expect(() => parseInvocation(["--surface", "host-bun", "--out", "/tmp/x", "--qualify", "a".repeat(40), "b".repeat(40)])).toThrow("unknown option");
  expect(() => parseInvocation(["--surface", "host-bun", "--out", "/tmp/x", "watch.nope"])).toThrow("unknown row");
  expect(() => parseInvocation(["--surface", "host-bun", "--out", "/tmp/x", "--fast"])).toThrow("unknown option");
  expect(parseInvocation(["--surface", "host-bun", "--out", "/tmp/x", "stdin.next-read-D"]).rows).toEqual(["stdin.next-read-D"]);
});

test("a resource row passes only with its exact frames in order", () => {
  const records: Observation[] = [["caller", "unrelated"], ["close", "C"]];
  expect(evaluateRow("watch.caller-close", run("watch.caller-close", records), "native").status).toBe("pass");
  expect(evaluateRow("watch.caller-close", run("watch.caller-close", [["caller", "unrelated"], ["close", "A"]]), "hooks").status).toBe("mismatch");
  expect(evaluateRow("watch.caller-close", run("watch.caller-close", records.toReversed()), "hooks").status).toBe("mismatch");
});

test("a turn-frame row is root on the hook path and never the operation's frame elsewhere", () => {
  const sends = (frame: string | null): Observation[] => [["message", "A", "ready"], ["send-B", frame, null], ["send-D", frame, null], ["message", "A", 2]];
  const verdict = (frame: string | null, mode: "hooks" | "native") => evaluateRow("ipc.blocked-send", run("ipc.blocked-send", sends(frame), { armed: true }), mode).status;
  expect(verdict(null, "hooks")).toBe("pass");
  expect(verdict("unrelated", "hooks")).toBe("mismatch");
  expect(verdict("unrelated", "native")).toBe("limited");
  expect(verdict("B", "native")).toBe("mismatch");
});

test("unarmed, late, hung, missing, errored and failed rows never pass", () => {
  const sends: Observation[] = [["message", "A", "ready"], ["send-B", null, null], ["send-D", null, null], ["message", "A", 2]];
  expect(evaluateRow("ipc.blocked-send", run("ipc.blocked-send", sends, { armed: false }), "hooks").status).toBe("unarmed");
  expect(evaluateRow("ipc.blocked-send", run("ipc.blocked-send", sends), "hooks").status).toBe("unarmed");
  const late: Observation[] = [["caller", "unrelated"], ["close", "C"], ["close", "C"]];
  expect(evaluateRow("watch.caller-close", run("watch.caller-close", late, { settled: 2 }), "hooks").status).toBe("late");
  expect(evaluateRow("watch.abort", run("watch.abort", [], { timedOut: true }), "hooks").status).toBe("hung");
  expect(evaluateRow("watch.abort", undefined, "hooks").status).toBe("missing");
  expect(evaluateRow("watch.abort", { ...run("watch.abort", []), report: null }, "hooks").status).toBe("missing");
  expect(evaluateRow("watch.abort", run("watch.abort", [["caller", "unrelated"], ["close", "D"]], { exitCode: 1 }), "hooks").status).toBe("exit");
  const errored = run("watch.abort", []);
  expect(evaluateRow("watch.abort", { ...errored, report: { ...errored.report!, error: "boom" } }, "hooks").status).toBe("error");
});

test("per-site rows keep each site's order and the declared first-callback order", () => {
  const records: Observation[] = [["message", "A", 1], ["message", "A", 2], ["exit", "A", 0], ["disconnect", "A"]];
  expect(evaluateRow("ipc.message-eof", run("ipc.message-eof", records), "hooks").status).toBe("pass");
  const reordered: Observation[] = [["disconnect", "A"], ["message", "A", 1], ["message", "A", 2], ["exit", "A", 0]];
  expect(evaluateRow("ipc.message-eof", run("ipc.message-eof", reordered), "hooks").reasons).toContain("first callbacks not in order message < disconnect");
  const extra = records.concat([["error", "A", "EPIPE"]]);
  expect(evaluateRow("ipc.message-eof", run("ipc.message-eof", extra), "hooks").status).toBe("mismatch");
});

test("the guest result boundary rejects malformed rows", () => {
  expect(() => parseGuestResult("{}")).toThrow("no rows");
  expect(() => parseGuestResult(JSON.stringify({ rows: [{ exitCode: 0 }] }))).toThrow("malformed row");
  expect(() => parseGuestResult(JSON.stringify({ execPath: "/bin/bun", rows: [{ id: "watch.abort", exitCode: 0, report: { id: "watch.abort", records: [["close", 3]], settled: 1 } }] }))).toThrow();
});

// Host Bun stands in for a guest here only to prove the READY gate, the result file and teardown.
test("the stdin gate feeds bytes after READY, and the run leaves no process group or staged copy", async () => {
  const out = mkdtempSync(join(tmpdir(), "bun-wasm-iorc-test-"));
  try {
    expect(await main(["--surface", "host-bun", "--out", out, "stdin.construct-A-activate-B"])).toBe(0);
    const result = JSON.parse(readFileSync(join(out, "result.json"), "utf8"));
    expect(result.qualification).toBe(false);
    expect(result.admission.kind).toBe("source-check-only");
    expect(result.coverage.omittedImplemented).toHaveLength(21);
    expect(result.rows[0].observed.map((record: Observation) => record[0])).toEqual(["data", "end"]);
    expect(result.rows[0].observed[0][2]).toBe("one\n");
    expect(result.cleanup).toEqual({ processGroupGone: true, workRemoved: true });
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}, 60_000);

function boundaryResult() {
  return { execPath: "/bin/bun", rows: [run("watch.caller-close", [["caller", "unrelated"], ["close", "C"]])] };
}

test("review R2: invalid boundary fields cannot normalize into a passing row", () => {
  const value = boundaryResult();
  const row = value.rows[0]!;
  expect(() => parseGuestResult(JSON.stringify({ ...value, rows: [{ ...row, timedOut: "true" }] }))).toThrow();
  expect(() => parseGuestResult(JSON.stringify({ ...value, rows: [{ ...row, report: { ...row.report, error: {} } }] }))).toThrow();
  expect(() => parseGuestResult(JSON.stringify({ ...value, rows: [{ ...row, report: { ...row.report, settled: 999 } }] }))).toThrow();
});

test("review R2: duplicate rows, missing requested rows and wrong routes reject", () => {
  const value = boundaryResult();
  expect(() => parseGuestResult(JSON.stringify({ ...value, rows: value.rows.concat(value.rows) }))).toThrow();
  expect(() => parseGuestResult(JSON.stringify(value), ["watch.abort"], ["/bin/bun"])).toThrow();
  expect(() => parseGuestResult(JSON.stringify({ ...value, execPath: "/opt/bun/jsc/bin/bun" }), ["watch.caller-close"], ["/bin/bun", "/opt/bun/quickjs/bin/bun"])).toThrow();
});

test("review R4: every decoded message precedes channel EOF disconnect", () => {
  const premature: Observation[] = [["message", "A", 1], ["disconnect", "A"], ["message", "A", 2], ["exit", "A", 0]];
  expect(evaluateRow("ipc.message-eof", run("ipc.message-eof", premature), "hooks").status).toBe("mismatch");
});

test("review R5: native turn exclusion is limited evidence, not exact preservation", () => {
  const records: Observation[] = [["message", "A", "ready"], ["send-B", "A", null], ["send-D", "A", null], ["message", "A", 2]];
  expect(evaluateRow("ipc.blocked-send", run("ipc.blocked-send", records, { armed: true }), "native").status).toBe("limited");
});

test("review R1: await compressed selected Browser bytes and preserve both identities", async () => {
  const url = "http://127.0.0.1/bun-browser.wasm";
  const bytes = Buffer.from("selected-browser-control");
  const expected = { sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
  const observer = loadedObserver(url, expected);
  const body = Promise.withResolvers<Uint8Array>();
  observer.capture(response(`${url}.gz?v=control`, () => body.promise));
  let finished = false;
  const result = observer.finish().then(value => { finished = true; return value; });
  await Bun.sleep(10);
  expect(finished).toBe(false);
  body.resolve(gzipSync(bytes));
  expect((await result).payloads[0]).toMatchObject({ encoding: "gzip", payload: expected });
  expect(isLoadedAsset(`${url}.gz?v=control`)).toBe(true);
});

test("review R1: unrelated Wasm and lost response bodies cannot arm Browser evidence", async () => {
  const observer = loadedObserver("http://127.0.0.1/bun-browser.wasm", { sha256: "a".repeat(64), bytes: 1 });
  observer.capture(response("http://127.0.0.1/programs/shell-engine.wasm", async () => new Uint8Array([0])));
  await expect(observer.finish()).rejects.toThrow("Selected Browser guest was not observed");
  observer.capture(response("http://127.0.0.1/bun-browser.wasm.gz", async () => { throw new Error("body unavailable"); }));
  await expect(observer.finish()).rejects.toThrow("body unavailable");
});

test("review R3: authoritative exit stream retains late callbacks and rejects duplicate finals", () => {
  const id = "watch.caller-close";
  const records: Observation[] = [["caller", "unrelated"], ["close", "C"], ["close", "C"]];
  const lines = records.slice(0, 2).map(record => `IORC_EVENT ${JSON.stringify({ id, record })}`);
  lines.push(`IORC_SETTLED ${JSON.stringify({ id, count: 2 })}`);
  lines.push(`IORC_EVENT ${JSON.stringify({ id, record: records[2] })}`);
  const final = `IORC_ROW ${JSON.stringify({ id, records, settled: 2, armed: null, error: null, execPath: "/bin/bun" })}`;
  lines.push(final);
  const report = parseRowOutput(lines.join("\n"), id);
  expect(evaluateRow(id, { id, report, exitCode: 0, timedOut: false, stderr: "" }, "hooks").status).toBe("late");
  expect(() => parseRowOutput(lines.concat(final).join("\n"), id)).toThrow("after final");
  expect(() => parseRowOutput(lines.concat(lines[0]!).join("\n"), id)).toThrow("after final");
});

test("review R6: missing and non-executable launcher controls settle and save failure", async () => {
  const out = mkdtempSync(join(tmpdir(), "bun-wasm-iorc-spawn-test-"));
  try {
    const missing = await runGroup(join(out, "missing"), [], out, out, 200);
    expect(missing).toMatchObject({ code: null, timedOut: false, groupGone: true });
    expect(missing.error).toContain("ENOENT");
    const control = join(import.meta.dir, "io-resource-context.test.ts");
    const result = await runGroup(control, [], out, out, 200);
    expect(result.error).toContain("EACCES");
    expect(result.groupGone).toBe(true);
    expect(await main(["--surface", "native", "--engine", "quickjs", "--guest", control, "--launcher", control, "--shell", control, "--env-utility", control, "--out", out, "watch.abort"])).toBe(1);
    expect(JSON.parse(readFileSync(join(out, "result.json"), "utf8"))).toMatchObject({ status: "fail", qualification: false, cleanup: { workRemoved: true, processGroupGone: true } });
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test("review R7: whole execution setup deadline reaches awaited cleanup", async () => {
  let cleaned = false;
  const before = process.listenerCount("SIGTERM");
  await expect(hostDeadline(20, async () => new Promise<never>(() => {}), async () => { await Bun.sleep(10); cleaned = true; })).rejects.toThrow("deadline");
  expect(cleaned).toBe(true);
  expect(process.listenerCount("SIGTERM")).toBe(before);
});

test("review R6/R7: a live host-only timeout stops its owned process group", async () => {
  const out = mkdtempSync(join(tmpdir(), "bun-wasm-iorc-timeout-test-"));
  try {
    const result = await runGroup(process.execPath, ["-e", "setInterval(() => {}, 1000)"], out, out, 30);
    expect(result).toMatchObject({ code: null, timedOut: true, groupGone: true });
  } finally { rmSync(out, { recursive: true, force: true }); }
});

function response(url: string, body: () => Promise<Uint8Array>, encoding?: string) {
  return { url: () => url, status: () => 200, headers: (): Record<string, string> => encoding ? { "content-encoding": encoding } : {}, request: () => ({ method: () => "GET" }), body };
}

// Synthetic fixture authority is deliberately insufficient to launch a real guest.
const schemaRoots: string[] = [];
function removeSynthetic(root: string): void {
  if (!lstatSync(root).isDirectory()) return;
  chmodSync(root, 0o700);
  for (const entry of readdirSync(root)) removeSynthetic(join(root, entry));
}
afterEach(() => {
  for (const root of schemaRoots.splice(0)) {
    removeSynthetic(root);
    rmSync(root, { recursive: true });
    expect(existsSync(root)).toBe(false);
  }
});
function syntheticHandoff() {
  const root = mkdtempSync(join(tmpdir(), "bun-wasm-iorc-schema-"));
  schemaRoots.push(root);
  const files = writeContractFixture(join(root, "records"));
  const pinned = readFiveOwnerHandoff(files.handoff, fileIdentity(files.handoff).sha256);
  return { ...files, pinned, root };
}

// The shared consumer fixture supplies consistent config/input copies and a clean synthetic Git tree.
async function syntheticSource() {
  const f = await qualificationFixture();
  schemaRoots.push(f.root);
  return { ...f, pinned: readFiveOwnerHandoff(f.handoff, fileIdentity(f.handoff).sha256) };
}

test("source binding checks actual clean Git source, config, original inputs and donor view", async () => {
  const f = await syntheticSource();
  expect(() => bindFiveOwnerSource(f.pinned, f.host)).not.toThrow();
  writeFileSync(join(f.host, "package.json"), "modified source");
  expect(() => bindFiveOwnerSource(f.pinned, f.host)).toThrow("dirty");
});

test("a pinned handoff cannot substitute fixture or dependency choices", async () => {
  const f = await syntheticSource();
  const h = f.pinned.handoff;
  const altered = { ...h, dependencies: { ...h.dependencies, browsers: { ...h.dependencies.browsers, sha256: "a".repeat(64) } } };
  writeFileSync(f.handoff, JSON.stringify(altered));
  expect(() => readFiveOwnerHandoff(f.handoff, fileIdentity(f.handoff).sha256)).toThrow("handoff differs");
  writeFileSync(f.handoff, JSON.stringify({ ...h, fixtures: { tls: { status: "unresolved", missing: "changed" } } }));
  expect(() => readFiveOwnerHandoff(f.handoff, fileIdentity(f.handoff).sha256)).toThrow("handoff differs");
});

test("original input custody and staged dependency bytes are not satisfied by their recorded labels", async () => {
  const f = await syntheticSource();
  const dependency = join(f.host, "node_modules/playwright/package.json");
  const original = readFileSync(dependency);
  writeFileSync(dependency, "changed tree");
  expect(() => bindFiveOwnerSource(f.pinned, f.host)).toThrow("root dependency view tree changed");
  writeFileSync(dependency, original);
  writeFileSync(join(f.root, "inputs.json"), "changed manifest");
  expect(() => bindFiveOwnerSource(f.pinned, f.host)).toThrow("original input manifest changed");
});

test("current controller fixture parses without claiming source or guest admission", () => {
  const f = syntheticHandoff();
  expect(f.pinned.handoff.schema).toBe("bun-wasm.c1-handoff/1");
  expect(f.pinned.handoff.tuple).toMatchObject({ runtime: "0.0.110", relay: "0.0.109" });
  expect(() => bindFiveOwnerOutput(f.pinned, "quickjs", join(f.pinned.handoff.outputs["five-owner"], "quickjs"))).not.toThrow();
  expect(() => bindFiveOwnerOutput(f.pinned, "jsc", join(f.root, "other"))).toThrow("output");
  expect(() => parseInvocation(["--surface", "native", "--engine", "quickjs", "--handoff", f.handoff, "--handoff-sha256", fileIdentity(f.handoff).sha256, "--out", join(f.pinned.handoff.outputs["five-owner"], "quickjs")])).toThrow("source");
});

test("handoff pin, tuple, unknown fields and registry routes fail closed", () => {
  const f = syntheticHandoff();
  expect(() => readFiveOwnerHandoff(f.handoff, "a".repeat(64))).toThrow("pinned");
  const h = f.pinned.handoff;
  const refuses = (value: unknown, message: string) => {
    writeFileSync(f.handoff, JSON.stringify(value));
    expect(() => readFiveOwnerHandoff(f.handoff, fileIdentity(f.handoff).sha256)).toThrow(message);
  };
  refuses({ ...h, tuple: { ...h.tuple, runtime: "0.0.109" } }, "source or tuple");
  refuses({ ...h, artifacts: { ...h.artifacts, unknown: h.artifacts.launcher } }, "unknown");
  refuses({ ...h, artifacts: { ...h.artifacts, launcher: h.artifacts.shell } }, "registry member");
});

test("the future executable mode is exact and never repaired by intake", () => {
  const f = syntheticHandoff();
  const launcher = f.pinned.handoff.artifacts.launcher.path;
  chmodSync(launcher, 0o444);
  expect(() => readFiveOwnerHandoff(f.handoff, f.pinned.reference.sha256)).toThrow("mode");
  expect(lstatSync(launcher).mode & 0o7777).toBe(0o444);
});

test("post-preflight modes, special bits, ancestors and bytes refuse immediately", () => {
  const f = syntheticHandoff();
  const path = f.pinned.handoff.artifacts.webIndex.path;
  const original = readFileSync(path);
  for (const mode of [0o644, 0o555, 0o4444]) {
    chmodSync(path, mode);
    expect(() => readFiveOwnerMember(f.pinned, path)).toThrow("member mode");
  }
  chmodSync(path, 0o444);
  chmodSync(f.pinned.handoff.webRoot, 0o755);
  expect(() => readFiveOwnerMember(f.pinned, path)).toThrow("directory mode");
  chmodSync(f.pinned.handoff.webRoot, 0o555);
  chmodSync(path, 0o644);
  writeFileSync(path, "changed bytes");
  chmodSync(path, 0o444);
  expect(() => readFiveOwnerMember(f.pinned, path)).toThrow("read bytes");
  expect(original.length).toBeGreaterThan(0);
});

test("unlisted and symlinked members cannot pass the per-read guard", () => {
  const f = syntheticHandoff();
  expect(() => requireFiveOwnerMember(f.pinned, join(f.delivery, "not-in-registry"))).toThrow("not an admitted");
  const path = f.pinned.handoff.artifacts.webIndex.path;
  chmodSync(f.pinned.handoff.webRoot, 0o755);
  rmSync(path);
  symlinkSync(f.handoff, path);
  chmodSync(f.pinned.handoff.webRoot, 0o555);
  expect(() => readFiveOwnerMember(f.pinned, path)).toThrow("member mode");
});

test("response evidence checks sealed modes both before and after the real body read", async () => {
  const f = syntheticHandoff();
  const url = "http://127.0.0.1:43839/bun-browser.wasm";
  const path = join(f.pinned.handoff.webRoot, "bun-browser.wasm.gz");
  const compressed = readFileSync(path);
  const bytes = Bun.gunzipSync(compressed);
  const observer = loadedObserver(url, { bytes: bytes.length, sha256: fileIdentity(f.pinned.handoff.artifacts.browserGuest.path).sha256 },
    path => requireFiveOwnerResponse(f.pinned, path));
  observer.capture(response(`${url}.gz`, async () => { chmodSync(path, 0o644); return compressed; }));
  await expect(observer.finish()).rejects.toThrow("member mode");
  let reads = 0;
  const before = loadedObserver(url, { bytes: bytes.length, sha256: "a".repeat(64) }, path => requireFiveOwnerResponse(f.pinned, path));
  before.capture(response(`${url}.gz`, async () => { reads++; return compressed; }));
  await expect(before.finish()).rejects.toThrow("member mode");
  expect(reads).toBe(0);
});

test("launch rechecks authenticated Chromium tree and later custody anchors", () => {
  const f = syntheticHandoff();
  const executable = join(f.pinned.handoff.dependencies.browsers.path, "entry");
  expect(() => recheckFiveOwnerBrowser(f.pinned, executable)).not.toThrow();
  expect(() => recheckFiveOwnerBrowser(f.pinned, f.handoff)).toThrow("outside");
  writeFileSync(executable, "changed");
  expect(() => recheckFiveOwnerBrowser(f.pinned, executable)).toThrow("browser inputs tree changed");
  writeFileSync(f.handoff, "changed");
  expect(() => recheckFiveOwnerHandoff(f.pinned)).toThrow("handoff changed");
});

test("raw gzip-only observations bind through the actual exported loaded validator", async () => {
  const f = syntheticHandoff();
  const url = "http://127.0.0.1:43839/bun-browser.wasm.gz";
  const compressed = readFileSync(join(f.pinned.handoff.webRoot, "bun-browser.wasm.gz"));
  const bytes = Bun.gunzipSync(compressed);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const observer = loadedObserver(url.slice(0, -3), { bytes: bytes.length, sha256: digest }, path => requireFiveOwnerResponse(f.pinned, path));
  observer.capture(response(url, async () => compressed));
  for (const name of ["index.html", "worker.js"]) {
    observer.capture(response(new URL(name, url).href, async () => readFileSync(join(f.pinned.handoff.webRoot, name))));
  }
  const observations = await observer.finish();
  const loaded = parseLoaded(observations.loaded);
  expect(loaded[0]?.encoding).toBe("identity");
  expect(loaded[0]?.bytes).toBe(compressed.length);
  expect(bindLoaded(f.pinned.handoff, "web", loaded)[0]?.member).toBe(join(f.pinned.handoff.webRoot, "bun-browser.wasm.gz"));
  expect(observations.payloads[0]?.payload.sha256).toBe(digest);
});

function completedRows() {
  return rowIds.map(id => run(id, rows[id].expect.map<Observation>(([site, frame, ...values]) =>
    [site, typeof frame === "object" && frame !== null ? null : frame, ...values]), { armed: true }));
}

test("exact output contract preserves native partial evidence and control nonqualification", () => {
  const f = syntheticHandoff();
  const artifacts = f.pinned.handoff.artifacts;
  const invocation: Invocation = { rows: rowIds, out: "/unused", evidence: f.pinned, surface: { kind: "native", engine: "quickjs", guest: artifacts.quickjsGuest.path,
    launcher: artifacts.launcher.path, shell: artifacts.shell.path, envUtility: artifacts.envUtility.path } };
  const input = { invocation, admitted: { artifacts: [], receipts: [] }, fixtureFiles: [], error: null,
    execution: { code: 0, timedOut: false, resultText: "", loaded: [], cleanup: { processGroupGone: true } },
    parsed: { execPath: "/bin/bun", rows: completedRows() }, workRemoved: true };
  const result: FiveOwnerResult = buildFiveOwnerResult(input);
  expect(result.schema).toBe(RESULT_SCHEMA);
  expect(result.status).toBe("partial");
  expect(result.qualification).toBe(false);
  expect(result.coverage.limitedNativeRows).toEqual(["ipc.blocked-send", "serve.root-registration"]);
  expect(result.unqualified).toHaveLength(10);
  expect(result.evidence).toMatchObject({ kind: "handoff", reference: f.pinned.reference, source: f.pinned.handoff.source });
  expect(buildFiveOwnerResult({ ...input, workRemoved: false })).toMatchObject({ status: "fail", qualification: false });
  expect(buildFiveOwnerResult({ ...input, execution: { ...input.execution, cleanup: { processGroupGone: false } } }).status).toBe("fail");
  const chromium: Invocation = { ...invocation, surface: { kind: "chromium", webRoot: f.pinned.handoff.webRoot } };
  const loaded = [{ url: "http://127.0.0.1:43839/bun-browser.wasm.gz", method: "GET", status: 200, encoding: "identity", bytes: 1, sha256: "a".repeat(64) }] satisfies Parameters<typeof bindLoaded>[2];
  const exact = { ...input, invocation: chromium, execution: { ...input.execution, loaded } };
  expect(buildFiveOwnerResult(exact)).toMatchObject({ status: "pass", qualification: true });
  expect(buildFiveOwnerResult({ ...exact, invocation: { ...chromium, rows: ["watch.abort"] } }).qualification).toBe(false);
  expect(buildFiveOwnerResult({ ...exact, invocation: { ...chromium, evidence: { kind: "source-check" } } }).qualification).toBe(false);
});

test("LoadedObservation is exact decoded HTTP body evidence, including HTML", async () => {
  const url = "http://127.0.0.1:43839/bun-browser.wasm";
  const body = new Uint8Array([1, 2, 3]);
  const digest = createHash("sha256").update(body).digest("hex");
  const observer = loadedObserver(url, { bytes: body.length, sha256: digest });
  observer.capture(response("http://127.0.0.1:43839/", async () => new Uint8Array([4])));
  observer.capture(response(url, async () => body, "gzip"));
  const { loaded } = await observer.finish();
  expect(loaded).toHaveLength(2);
  expect(loaded[1]).toEqual({ url, method: "GET", status: 200, encoding: "gzip", bytes: 3, sha256: digest });
  expect(Object.keys(loaded[1]!).toSorted()).toEqual(["bytes", "encoding", "method", "sha256", "status", "url"]);
});
