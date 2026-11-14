import { namedCheckBatches } from "./test-checks";

// Hang detection only. Leave half of the ten-minute job for setup and process teardown.
const hangTimeoutSeconds = 300;

export function webBrowserShards(batches = namedCheckBatches("web-browser")) {
  return batches.map(({ name }) => ({ batch: name, timeoutSeconds: hangTimeoutSeconds }));
}

if (import.meta.main) console.log(JSON.stringify({ include: webBrowserShards() }));
