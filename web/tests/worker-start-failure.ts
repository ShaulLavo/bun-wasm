import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { claimOutcome, outcomeWord, processOutcome, readOutcome } from "../../runtime/proc/outcome";
import { revokeFilesystem, sharedRevoked } from "../../runtime/fs";
import type { RunRequest, WorkerMessage } from "../src/worker";

const source = new Bun.Transpiler({ loader: "ts", target: "browser" }).transformSync(
  readFileSync(new URL("../src/worker.ts", import.meta.url), "utf8")
    .replace(/^import .*;\n/gm, "")
    .replace(/^export /gm, "")
    .replace(/import\("\.\.\/\.\.\/runtime\/proc\/worker-client"\)/g, "loadRuntime()"),
);

export async function failFirstWorkerImport(request: RunRequest, postMessage: (message: WorkerMessage) => void) {
  const context = {
    crossOriginIsolated: true, postMessage,
    onmessage: undefined as unknown as (event: { data: RunRequest }) => Promise<void>,
  };
  runInNewContext(source, {
    self: context, performance, Response, TextEncoder, Error,
    SharedArrayBuffer, Atomics, Int32Array, BigInt64Array,
    FilesystemClient: class {
      connection = request.filesystem;
      dispose() {}
    },
    WasiExit: class extends Error {},
    revokeFilesystem, sharedRevoked, claimOutcome, outcomeWord, processOutcome, readOutcome,
    loadRuntime: async () => { throw new Error("first worker-client import rejected"); },
  });
  await context.onmessage({ data: request });
}
