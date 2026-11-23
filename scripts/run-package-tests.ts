import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { runShardedFiles, testJobs } from "./test-checks.ts";

const root = resolve(import.meta.dir, "..");
const directory = join(root, "tests/package");
const files = readdirSync(directory).sort().filter(file => file.endsWith(".test.ts")).map(file => join(directory, file));
if (files.length === 0) throw new Error("No package tests found");
const jobs = testJobs(process.env.BUN_WASM_TEST_JOBS);
process.exitCode = await runShardedFiles(files, jobs, process.env);
