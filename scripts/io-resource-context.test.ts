// Host-only checks of the live driver: argument boundary, row evaluation and the stdin gate with
// cleanup. Nothing here runs a guest engine, so no result counts as an engine pass.
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateRow, main, parseGuestResult, parseInvocation, type RowRun } from "./io-resource-context.ts";
import type { Observation, RowId } from "../tests/fixtures/io-resource-context/rows.ts";
import { parseRowOutput } from "../tests/fixtures/io-resource-context/protocol.ts";
import { isLoadedAsset, loadedObserver } from "./io-resource-context-assets.ts";
import { hostDeadline, runGroup } from "./io-resource-context.ts";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

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
  expect(() => parseInvocation(["--surface", "host-bun", "--out", "/tmp/x", "--qualify", "a".repeat(40), "b".repeat(40)])).toThrow("cannot qualify");
  expect(() => parseInvocation(["--surface", "host-bun", "--out", "/tmp/x", "--qualify", "short", "b".repeat(40)])).toThrow("40-hex");
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
    expect(result.admission.kind).toBe("pending-controller-interface");
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
  observer.capture({ url: () => `${url}.gz?v=control`, ok: () => true, body: () => body.promise });
  let finished = false;
  const result = observer.finish().then(value => { finished = true; return value; });
  await Bun.sleep(10);
  expect(finished).toBe(false);
  body.resolve(gzipSync(bytes));
  expect((await result)[0]).toMatchObject({ encoding: "gzip", payload: expected });
  expect(isLoadedAsset(`${url}.gz?v=control`)).toBe(true);
});

test("review R1: unrelated Wasm and lost response bodies cannot arm Browser evidence", async () => {
  const observer = loadedObserver("http://127.0.0.1/bun-browser.wasm", { sha256: "a".repeat(64), bytes: 1 });
  observer.capture({ url: () => "http://127.0.0.1/programs/shell-engine.wasm", ok: () => true, body: async () => new Uint8Array([0]) });
  await expect(observer.finish()).rejects.toThrow("Selected Browser guest was not observed");
  observer.capture({ url: () => "http://127.0.0.1/bun-browser.wasm.gz", ok: () => true, body: async () => { throw new Error("body unavailable"); } });
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
