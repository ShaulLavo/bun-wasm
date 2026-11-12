import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

function activity() {
  const beforeMs = performance.now();
  let value = 1;
  while (performance.now() - beforeMs < 400) value = (value * 48271) % 2147483647;
  const path = ".perf-activity";
  const data = "activity".repeat(16384);
  for (let index = 0; index < 8; index++) { writeFileSync(path, data); if (readFileSync(path, "utf8") !== data) throw new Error("Filesystem control failed"); }
  console.log("PERF_ACTIVITY", JSON.stringify({ beforeMs, afterMs: performance.now(), value }));
}
function child(mode: string) {
  const beforeMs = performance.now();
  const result = spawnSync(process.execPath, [process.argv[1]!, mode], { stdio: "inherit" });
  if (result.status !== 0 || result.error) throw new Error(`Child ${mode} failed: ${result.status} ${result.error}`);
  return { mode, beforeMs, afterMs: performance.now(), status: result.status };
}
if (process.argv[2] === "leaf") activity();
else if (process.argv[2] === "nested") { activity(); console.log("PERF_NESTED", JSON.stringify(child("leaf"))); }
else {
  activity();
  console.log("PERF_CHILD", JSON.stringify(child("leaf")));
  console.log("PERF_ROOT", JSON.stringify(child("nested")));
}
