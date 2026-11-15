import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { instrumentConsumerPreview, instrumentHelper, instrumentProjection, instrumentRouter, instrumentSandbox, instrumentWorker, verifySource } from "./storage-routing-build-source";

const transforms = {
  "browser/service-worker.ts": instrumentWorker,
  "browser/preview.ts": instrumentRouter,
  "browser/net/helper.ts": instrumentHelper,
  "browser/net/runtime.ts": instrumentProjection,
};
export function routingObservationSource(path: string, source: string): string | undefined {
  const collector = `import ${JSON.stringify(resolve(import.meta.dir, "storage-routing-collector.ts"))};\n`;
  if (/\/(?:sandbox|web)\/src\/main\.ts$/.test(path) || path.endsWith("/web/src/sw.ts")) return collector + source;
  if (path.endsWith("/sandbox/src/sandbox.ts")) return instrumentSandbox(source);
  if (path.endsWith("/web/src/preview.ts")) return instrumentConsumerPreview(source);
  for (const [name, transform] of Object.entries(transforms)) {
    if (path.endsWith("/waffle/" + name)) return transform(source);
  }
}
export function verifyRoutingInstallation(runtime: string): void {
  const metadata: unknown = JSON.parse(readFileSync(join(runtime, "package.json"), "utf8"));
  if (!metadata || typeof metadata !== "object" || !("version" in metadata) || metadata.version !== "0.0.136") throw Error("Storage routing requires the complete installed Waffle .136");
  for (const name of Object.keys(transforms)) verifySource(name, readFileSync(join(runtime, name), "utf8"));
}
