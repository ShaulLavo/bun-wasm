function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Missing CI result object");
  return Object.fromEntries(Object.entries(value));
}

function selected(outputs: Record<string, unknown>, name: string): boolean {
  const value = outputs[name];
  if (value !== "true" && value !== "false") throw new Error(`Invalid CI selection: ${name}`);
  return value === "true";
}

export function requireCiSuccess(value: unknown, event = "pull_request"): void {
  if (!["pull_request", "push", "workflow_dispatch"].includes(event)) throw new Error(`Invalid CI event: ${event}`);
  const results = object(value);
  const quality = object(results.quality);
  if (quality.result !== "success") throw new Error(`Source quality did not pass: ${String(quality.result)}`);
  const selection = object(results.selection);
  if (selection.result !== "success") throw new Error(`CI selection did not pass: ${String(selection.result)}`);
  const outputs = object(selection.outputs);
  const rust = selected(outputs, "rust");
  const browser = selected(outputs, "browser_guest");
  const jsc = selected(outputs, "jsc");
  if (rust && !browser) throw new Error("Native production must retain Browser consumers");
  if (jsc && !browser) throw new Error("JSC consumers require guest production");
  const native = rust || (event !== "pull_request" && browser);
  const sharedNative = selected(outputs, "shared-native");
  if (!rust && sharedNative) throw new Error("Native consumers require the native route");
  const shared = selected(outputs, "shared") || sharedNative;
  const expected = {
    selection: true, quality: true, "jsc-identity": browser, "jsc-prebuild": browser, "native-quality": native, rust: native,
    "browser-production": browser && !native, "ordinary-web-guests": native,
    package: true, "shared-jsc-identity": shared, "shared-prebuild": shared, "shared-spidermonkey-prebuild": sharedNative,
    "shared-sysroot": shared, "shared-proof-inputs": sharedNative, "shared-native": sharedNative, "shared-browser": sharedNative, "shared-proof": shared,
    web: true, "web-unit": true, "web-browser": true, "process-bundles": true, "browser-guest": browser, "browser-process": true,
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
  requireCiSuccess(JSON.parse(input), process.env.GITHUB_EVENT_NAME ?? "");
  console.log("Every selected CI job passed");
}
