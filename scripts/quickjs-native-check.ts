// Shared setup for the native QuickJS contract checks: the repository root, the engine source
// directory to build, and a scratch directory that is removed on exit and on interruption.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type NativeCheck = { root: string; engine: string; scratch: string; cleanup(): void };

export function nativeCheck(scratchPrefix: string, engineArgument: string | undefined): NativeCheck {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const scratch = mkdtempSync(join(tmpdir(), scratchPrefix));
  const cleanup = (): void => rmSync(scratch, { recursive: true, force: true });
  for (const [signal, status] of [["SIGTERM", 143], ["SIGINT", 130]] as const) {
    process.once(signal, () => { cleanup(); process.exit(status); });
  }
  return { root, engine: resolve(engineArgument ?? join(root, "third_party/rquickjs-sys/quickjs")), scratch, cleanup };
}
