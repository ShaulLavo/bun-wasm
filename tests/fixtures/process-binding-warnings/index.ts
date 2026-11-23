// Under --pending-deprecation, process.binding() (DEP0111) and process.binding("uv").errname()
// (DEP0119) each warn once per thread: the main thread and a worker count one of each.
import { Worker } from "node:worker_threads";

process.removeAllListeners("warning");
const counts: Record<string, number> = {};
process.on("warning", warning => {
  const code = (warning as Error & { code: string }).code;
  counts[code] = (counts[code] ?? 0) + 1;
});

function provoke(): void {
  process.binding("uv").errname(-2);
  process.binding("uv").errname(-2);
}
provoke();

const worker = new Worker(
  `const { parentPort } = require("node:worker_threads");
   process.removeAllListeners("warning");
   const counts = {};
   process.on("warning", warning => { counts[warning.code] = (counts[warning.code] ?? 0) + 1; });
   process.binding("uv").errname(-2);
   process.binding("uv").errname(-2);
   setImmediate(() => parentPort.postMessage(counts));`,
  { eval: true },
);
worker.on("message", message => {
  setImmediate(() => {
    console.log("main", JSON.stringify(counts));
    console.log("worker", JSON.stringify(message));
  });
});
