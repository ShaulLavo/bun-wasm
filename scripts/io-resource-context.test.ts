// Host-only checks of the live driver: argument boundary, row evaluation and the stdin gate with
// cleanup. Nothing here runs a guest engine, so no result counts as an engine pass.
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateRow, main, parseGuestResult, parseInvocation, type RowRun } from "./io-resource-context.ts";
import type { Observation, RowId } from "../tests/fixtures/io-resource-context/rows.ts";

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
  expect(verdict("unrelated", "native")).toBe("pass");
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
  expect(evaluateRow("ipc.message-eof", run("ipc.message-eof", reordered), "hooks").reasons).toEqual(["first callbacks not in order message < disconnect"]);
  const extra = records.concat([["error", "A", "EPIPE"]]);
  expect(evaluateRow("ipc.message-eof", run("ipc.message-eof", extra), "hooks").status).toBe("mismatch");
});

test("the guest result boundary rejects malformed rows", () => {
  expect(() => parseGuestResult("{}")).toThrow("no rows");
  expect(() => parseGuestResult(JSON.stringify({ rows: [{ exitCode: 0 }] }))).toThrow("malformed row");
  const parsed = parseGuestResult(JSON.stringify({ execPath: "/bin/bun", rows: [{ id: "watch.abort", exitCode: 0, report: { id: "watch.abort", records: [["close", 3]], settled: 1 } }] }));
  expect(parsed.rows[0]?.report).toBeNull();
});

// Host Bun stands in for a guest here only to prove the READY gate, the result file and teardown.
test("the stdin gate feeds bytes after READY, and the run leaves no process group or staged copy", async () => {
  const out = mkdtempSync(join(tmpdir(), "bun-wasm-iorc-test-"));
  try {
    expect(await main(["--surface", "host-bun", "--out", out, "stdin.construct-A-activate-B"])).toBe(0);
    const result = JSON.parse(readFileSync(join(out, "result.json"), "utf8"));
    expect(result.qualification).toBe(false);
    expect(result.rows[0].observed.map((record: Observation) => record[0])).toEqual(["data", "end"]);
    expect(result.rows[0].observed[0][2]).toBe("one\n");
    expect(result.cleanup).toEqual({ processGroupGone: true, workRemoved: true });
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}, 60_000);
