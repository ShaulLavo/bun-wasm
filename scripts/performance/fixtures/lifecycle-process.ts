import { mkdirSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";

const [mode, root] = process.argv.slice(2);
if (!root) throw new Error("Missing owned fixture root");
if (mode === "outputs" || mode === "fail") {
  for (const path of [".next", ".next/server", ".next/server/pages"]) mkdirSync(join(root, path), { recursive: true });
  for (const path of [".next/BUILD_ID", ".next/build-manifest.json", ".next/server/pages/index.html"]) writeFileSync(join(root, path), "fixture output");
  process.exitCode = mode === "fail" ? 2 : 0;
} else if (mode === "descendant") {
  const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: "ignore" });
  writeFileSync(join(root, "child.pid"), String(child.pid));
  setInterval(() => {}, 1000);
} else if (mode === "selection") {
  const arities: number[] = [];
  process.dlopen = (...args) => { arities.push(args.length); };
  await import("../lifecycle-selection");
  process.dlopen({ exports: {} }, import.meta.filename);
  process.dlopen({ exports: {} }, import.meta.filename, 2);
  writeFileSync(join(root, "arities.json"), JSON.stringify(arities));
} else if (mode === "empty") process.exitCode = 0;
else throw new Error(`Unknown fixture mode ${mode}`);
