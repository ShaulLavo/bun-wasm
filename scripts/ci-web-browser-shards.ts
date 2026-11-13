import { namedCheckBatches } from "./test-checks";

// Measured runs and the 12.5% margin are recorded in .internal/ci/web-browser-shards.md.
const deadlines: Readonly<Record<string, number>> = {
  "10-interface": 150,
  "20-preview": 150,
  "30-lifecycle": 150,
};

export function webBrowserShards(batches = namedCheckBatches("web-browser")) {
  if (batches.length !== Object.keys(deadlines).length) throw new Error("Web browser shards must match the measured deadlines");
  return batches.map(({ name }) => {
    const timeoutSeconds = deadlines[name];
    if (timeoutSeconds === undefined) throw new Error(`Unmeasured Web browser shard: ${name}`);
    return { batch: name, timeoutSeconds };
  });
}

if (import.meta.main) console.log(JSON.stringify({ include: webBrowserShards() }));
