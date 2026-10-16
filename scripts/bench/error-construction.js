// Run with bun run scripts/bench/error-construction.js in each runtime artifact.
const saved = Error.prepareStackTrace;
Error.stackTraceLimit = 10;
const count = 10000;
let calls = 0;
function custom(error, sites) { calls++; return sites.map(site => site.toString()).join("\n"); }
for (const [name, prepare, create] of [
  ["new Error default", saved, () => new Error("unread")],
  ["capture default", saved, () => { const target = {}; Error.captureStackTrace(target); return target; }],
  ["new Error custom", custom, () => new Error("unread")],
  ["capture custom", custom, () => { const target = {}; Error.captureStackTrace(target); return target; }],
]) {
  Error.prepareStackTrace = prepare;
  for (let i = 0; i < 1000; i++) globalThis.errorSink = create();
  calls = 0;
  const samples = [];
  for (let sample = 0; sample < 5; sample++) {
    const start = performance.now();
    for (let i = 0; i < count; i++) globalThis.errorSink = create();
    samples.push((performance.now() - start) * 1000 / count);
  }
  samples.sort((a, b) => a - b);
  console.log(JSON.stringify({ name, count, samples_us: samples, median_us: samples[2], formatter_calls: calls }));
}
Error.prepareStackTrace = saved;
