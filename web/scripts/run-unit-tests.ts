import { readdirSync } from "node:fs";
import { join } from "node:path";
import { runShardedFiles, testJobs } from "../../scripts/test-checks.ts";

const jobs = testJobs(process.env.BUN_WASM_TEST_JOBS);
const testsDir = join(import.meta.dir, "../tests");
const files = readdirSync(testsDir)
  .filter(file => /\.test\.(?:js|ts)$/.test(file))
  .sort()
  .map(file => join(testsDir, file));
process.exitCode = await runShardedFiles(files, jobs);
