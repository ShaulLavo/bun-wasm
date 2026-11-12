import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { EXPECTED, KINDS, SCENARIO, type Kind, type Sites } from "./bun-listen-scenario.ts";

// Native Bun's frames for the shared Bun.listen and Bun.connect scenario, over a loopback
// connection. Run with Bun.

type Run = { seen: Sites; listener: { stop(force?: boolean): void }; client: Promise<unknown> };

async function scenario(kind: Kind): Promise<Sites> {
  const storage = new AsyncLocalStorage<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let run: Run | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${kind}: reference sockets did not close`)), 5_000);
      // oxlint-disable-next-line no-eval -- Evaluate the shared scenario text as the adapter modes do.
      run = (0, eval)(SCENARIO)(storage, Bun, kind, resolve) as Run;
      run.client.catch(reject);
    });
    return run!.seen;
  } finally {
    clearTimeout(timer);
    run?.listener.stop(true);
    storage.disable();
  }
}

const results: Record<string, Sites> = {};
for (const kind of KINDS) results[kind] = await scenario(kind);
assert.deepEqual(results, EXPECTED);
console.log(`BUN_LISTEN_REFERENCE ${JSON.stringify({ runtime: `native Bun ${Bun.version}`, results })}`);
