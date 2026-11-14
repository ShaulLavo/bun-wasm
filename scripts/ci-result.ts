function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Missing CI result object");
  return Object.fromEntries(Object.entries(value));
}

function selected(outputs: Record<string, unknown>, name: string): boolean {
  const value = outputs[name];
  if (value !== "true" && value !== "false") throw new Error(`Invalid CI selection: ${name}`);
  return value === "true";
}

export function requireCiSuccess(value: unknown): void {
  const results = object(value);
  const quality = object(results.quality);
  if (quality.result !== "success") throw new Error(`Source quality did not pass: ${String(quality.result)}`);
  const selection = object(results.selection);
  if (selection.result !== "success") throw new Error(`CI selection did not pass: ${String(selection.result)}`);
  const outputs = object(selection.outputs);
  const rust = selected(outputs, "rust");
  const sharedNative = selected(outputs, "shared-native");
  const shared = selected(outputs, "shared") || sharedNative;
  const expected = {
    selection: true, quality: true, "jsc-identity": rust, "jsc-prebuild": rust, "native-quality": rust, rust,
    package: true, "shared-jsc-identity": shared, "shared-prebuild": shared, "shared-spidermonkey-prebuild": sharedNative,
    "shared-sysroot": shared, web: true, "web-unit": true, "web-browser": true, "process-bundles": true, "browser-guest": rust, "browser-process": true,
  };
  for (const [name, required] of Object.entries(expected)) {
    const result = object(results[name]).result;
    const wanted = required ? "success" : "skipped";
    if (result !== wanted) throw new Error(`${name} must be ${wanted}, got ${String(result)}`);
  }
}

if (import.meta.main) {
  const input = process.env.CI_RESULTS;
  if (!input) throw new Error("Missing CI_RESULTS");
  requireCiSuccess(JSON.parse(input));
  console.log("Every selected CI job passed");
}
