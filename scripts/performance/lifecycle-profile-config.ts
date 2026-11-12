import { canonical, object } from "./input";
import { chromeTraceConfig } from "./lifecycle-profile-retention";

export const geckoCollectorConfig = { intervalMs: 5, entries: 8000000, features: "js,cpu", filters: "DOM Worker,GeckoMain,JS Helper" };

export function collectorConfiguration(browser: "chrome" | "firefox") {
  if (browser === "chrome") return chromeTraceConfig;
  return geckoCollectorConfig;
}

export function validateProfileControl(input: unknown, expected: { browser: string; engine: string }, context: unknown): void {
  const control = object(input), configuration = object(control.configuration);
  const profile = object(object(control.observation).profile);
  if (configuration.browser !== expected.browser || configuration.engine !== expected.engine || configuration.phase !== "control" ||
    profile.available !== true || control.workloadFailure !== null || control.observerFailure !== null) {
    throw new Error("Exact-context profiler control unavailable; actual capture is gated");
  }
  if (!control.collectorContext || canonical(control.collectorContext) !== canonical(context)) {
    throw new Error("Profiler control collector configuration, source or browser context differs");
  }
  if (expected.browser !== "chrome") return;
  const retention = object(profile.retention);
  if (retention.available !== true) throw new Error("Chrome control has incomplete or unverified trace retention");
  if (!retention.verifiedRequest || canonical(retention.verifiedRequest) !== canonical(object(control.collectorContext).collector)) {
    throw new Error("Chrome control accepted collector request differs from its declared context");
  }
  const markers = object(control.chromeWindowMarkers), bounds = object(profile.workloadWindow), source = object(bounds.source);
  if (bounds.available !== true || markers.begin !== source.begin || markers.end !== source.end) {
    throw new Error("Chrome control command boundaries do not match its scoped analysis");
  }
}
