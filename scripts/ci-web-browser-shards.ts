import { namedCheckBatches } from "./test-checks";

// Complete hosted command measurements are in .internal/ci/web-browser-shards.md.
const baselineSeconds: Readonly<Record<string, number>> = {
  "10-interface": 111.684,
  "20-preview": 92.313,
  "30-lifecycle": 86.502,
};

export function webBrowserShards(batches = namedCheckBatches("web-browser")) {
  if (batches.length !== Object.keys(baselineSeconds).length) throw new Error("Web browser shards must match the measured deadlines");
  return batches.map(({ name }) => {
    const baseline = baselineSeconds[name];
    if (baseline === undefined) throw new Error(`Unmeasured Web browser shard: ${name}`);
    return { batch: name, timeoutSeconds: Math.ceil(baseline * 1.125) };
  });
}

if (import.meta.main) console.log(JSON.stringify({ include: webBrowserShards() }));
