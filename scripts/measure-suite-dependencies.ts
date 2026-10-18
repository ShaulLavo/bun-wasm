import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const { values } = parseArgs({
  options: {
    dependencies: { type: "string" },
    output: { type: "string" },
  },
});
if (!values.dependencies || !values.output) {
  throw new Error("Use --dependencies <installed node_modules> --output <new results directory>");
}

const root = fileURLToPath(new URL("../", import.meta.url));
const files = readFileSync(root + "docs/bun-test-suite/dependency-files.txt", "utf8").trim().split("\n");
const dependencies = resolve(values.dependencies);
const output = resolve(values.output);
for (const engine of ["quickjs", "jsc", "browser"]) {
  const args = [
    "--engine", engine, "--network", "loopback", "--jobs", "1", "--timeout", "15",
    "--dependencies", dependencies, "--output", `${output}/${engine}.json`,
    "--log-dir", `${output}/${engine}-logs`,
  ].concat(files);
  const result = spawnSync(root + "scripts/bun-suite.sh", args, { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
