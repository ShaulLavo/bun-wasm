// Existing build/cache controls inspect the ordered work across both native jobs.
// Job-specific admission and setup duplication are checked against the real DAG.
export function nativePipeline(source: string) {
  const prebuild = source.split("\n  jsc-prebuild:\n")[1]!.split("\n  native-quality:\n")[0]!;
  const checkpoint = source.split("\n  native-quality:\n")[1]!.split("\n  rust:\n")[0]!;
  const consumer = source.split("\n  rust:\n")[1]!.split("\n  package:\n")[0]!;
  const prefix = checkpoint.split("      - name: Package the verified native quality checkpoint\n")[0]!;
  const sideRestore = consumer.match(/      - uses: actions\/cache\/restore@v4\n        if: needs\.quality\.outputs\.jsc == 'true'\n        id: jsc-cargo-cache\n[^]*?(?=      - name: Restore the bash-web shell guest build\n)/)?.[0];
  const tail = consumer.slice(consumer.indexOf("      - name: Restore the bash-web shell guest build\n"));
  if (!sideRestore || !tail || prefix === checkpoint) throw new Error("Missing native checkpoint boundary");
  return { prebuild, checkpoint, consumer, ordered: prefix + sideRestore + tail };
}
