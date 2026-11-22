// Existing build/cache controls inspect the ordered work across the native pipeline jobs.
export function nativePipeline(source: string) {
  const checkpoint = source.split("\n  native-quality:\n")[1]!.split("\n  ordinary-build:\n")[0]!;
  const producer = source.split("\n  ordinary-build:\n")[1]!.split("\n  shared-sysroot:\n")[0]!;
  const runtime = source.split("\n  rust:\n")[1]!.split("\n  rust-fixtures:\n")[0]!;
  const fixtures = source.split("\n  rust-fixtures:\n")[1]!.split("\n  browser-guest:\n")[0]!;
  const body = (job: string) => {
    const start = job.indexOf("    steps:\n");
    if (start < 0) throw new Error("Missing steps boundary");
    return job.slice(start + "    steps:\n".length);
  };
  const prefix = checkpoint;
  const producerSteps = body(producer);
  const runtimeSteps = body(runtime);
  const fixtureSteps = body(fixtures);
  return {
    prebuild: producer,
    checkpoint,
    consumer: producer,
    runtime,
    fixtures,
    web: runtime,
    ordered: prefix + producerSteps + runtimeSteps + fixtureSteps,
  };
}
