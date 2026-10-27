import ts from "typescript-api";
import { parentPort, workerData } from "node:worker_threads";

if (typeof workerData !== "string") throw new TypeError("Expected TypeScript source");
const result = ts.transpileModule(workerData, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  fileName: "next.config.ts",
});
parentPort?.postMessage(result.outputText);
