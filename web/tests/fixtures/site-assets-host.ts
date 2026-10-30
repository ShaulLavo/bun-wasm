import { createRequire } from "node:module";
import { unstable_getMiniflareWorkerOptions } from "wrangler";

const [config, bundle] = process.argv.slice(2);
if (!config || !bundle) throw new Error("Usage: site-assets-host.ts <config> <Worker bundle>");
const require = createRequire(import.meta.resolve("wrangler"));
const { Miniflare, convertV4MiniflareOptions }: typeof import("miniflare") = require("miniflare");
const { workerOptions, externalWorkers } = unstable_getMiniflareWorkerOptions(config);
const { modulesRules: _rules, ...bindings } = workerOptions;
const workers: import("miniflare").V4WorkerOptions[] = [{
  ...bindings, name: "program-assets", modules: true, scriptPath: bundle,
  unsafeDirectSockets: [{ host: "127.0.0.1", port: 0 }],
}];
const runtime = new Miniflare(convertV4MiniflareOptions({ port: 0, cf: false, workers: workers.concat(externalWorkers) }));
let closing: Promise<void> | undefined;
function close(): Promise<void> { return closing ??= runtime.dispose(); }
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(signal, () => { void close(); });
try {
  await runtime.ready;
  console.log(`Ready on ${await runtime.unsafeGetDirectURL()}`);
} catch (error) {
  await close();
  throw error;
}
