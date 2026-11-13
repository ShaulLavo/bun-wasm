import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ownedDatabase, type SuiteAdapter } from "waffle/testing/page-runner";
import { prepareProcessBundle, processDirectoryAssets } from "./process-page-assets";
import { runtimeProcFilesystemName, runtimeProcIds, runtimeProcLimits, runtimeProcQuery, runtimeProcRows, type RuntimeProcRequest } from "./runtime-proc-page-contract";
import { checkRuntimeProcResult } from "./runtime-proc-result";

export const runtimeProcAdapter: SuiteAdapter<RuntimeProcRequest> = {
  suite: "bun-runtime-proc",
  inventory: () => runtimeProcRows.map((row, index) => ({
    id: runtimeProcIds[index]!, label: `${row.scenario}/${row.mode}`,
    request: run => ({ databaseName: runtimeProcFilesystemName(run) }),
    query: () => runtimeProcQuery(row),
    console: "fail-on-error",
  })),
  policy: {
    listIds(value) {
      assert.deepEqual(value, { ids: runtimeProcIds }, "runtime_proc inventory changed");
      return runtimeProcIds.slice();
    },
    requireResult: true,
    allocation: ownedDatabase("bun-runtime-proc"),
    check(id, result) {
      const row = runtimeProcRows.find((_, index) => runtimeProcIds[index] === id);
      assert.ok(row, "unknown runtime_proc row");
      assert.ok(result !== null && typeof result === "object" && "result" in result && "errors" in result, "runtime_proc observation required");
      checkRuntimeProcResult(result.result, row.scenario, result.errors);
    },
  },
  async assets(context) {
    context.signal.throwIfAborted();
    const out = join(context.scratch, "current");
    await mkdir(out);
    await prepareProcessBundle(out, context.signal, "runtime-proc");
    return processDirectoryAssets(out, context.signal);
  },
  budgets: () => ({ hello: 20_000, heartbeat: 10_000, case: runtimeProcLimits.resultMs, group: runtimeProcLimits.commandMs, run: runtimeProcLimits.commandMs }),
  resultWaitMs: runtimeProcLimits.resultMs,
  page: { path: "/current/", script: "/current/runtime-proc-browser-main.js" },
};
