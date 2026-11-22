import { namedCheckBatches } from "./test-checks";

const hangTimeoutSeconds = 300;
const pairs = [
  ["10-interface", "21-preview-navigation"],
  ["20-preview", "30-lifecycle"],
] as const;

export function webBrowserShards(batches = namedCheckBatches("web-browser")) {
  const shards = new Map(batches.map(({ name }) => [name, { batch: name, pairedBatch: "", timeoutSeconds: hangTimeoutSeconds }]));
  for (const [batch, pairedBatch] of pairs) {
    const shard = shards.get(batch);
    if (!shard || !shards.delete(pairedBatch)) continue;
    shard.pairedBatch = pairedBatch;
  }
  return Array.from(shards.values());
}

if (import.meta.main) console.log(JSON.stringify({ include: webBrowserShards() }));
