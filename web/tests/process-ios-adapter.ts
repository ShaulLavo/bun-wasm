import assert from "node:assert/strict";
import { ownedDatabase, type SuiteAdapter } from "waffle/testing/page-runner";
import { checkProcessResult, processCommandId, processCommandLimits, processFilesystemName, type ProcessRequest } from "./process-page-adapter";
import { prepareProcessAssets } from "./process-page-assets";

export const processAdapter: SuiteAdapter<ProcessRequest> = {
  suite: "bun-process",
  inventory: () => [{ id: processCommandId, label: "default", request: run => ({ databaseName: processFilesystemName(run) }) }],
  policy: {
    listIds(value) {
      assert.deepEqual(value, { ids: [processCommandId] }, "process command inventory changed");
      return [processCommandId];
    },
    requireResult: true,
    allocation: ownedDatabase("bun-process"),
    check: (_id, result) => checkProcessResult(result),
  },
  assets: prepareProcessAssets,
  budgets: () => ({ hello: 20_000, heartbeat: 10_000, case: processCommandLimits.commandMs, group: processCommandLimits.commandMs, run: processCommandLimits.commandMs }),
  resultWaitMs: processCommandLimits.resultMs,
  page: { path: "/current/", script: "/current/process-browser-main.js" },
};
