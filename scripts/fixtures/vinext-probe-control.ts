import { mock } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";

const [directory, scenario] = process.argv.slice(2);
if (!directory || !scenario) throw new Error("Expected test directory and scenario");
const root = resolve(import.meta.dir, "../..");
const assets = join(directory, "assets");
mkdirSync(assets);
for (const name of ["bun.wasm", "quickjs.wasm"]) writeAsset(name);
function writeAsset(name: string) {
  if (scenario === "missing") return;
  if (scenario !== "gzip-only") writeFileSync(join(assets, name), "probe payload");
  if (scenario === "plain-only") return;
  const payload = scenario === "mismatch" ? "different loaded payload" : "probe payload";
  writeFileSync(join(assets, `${name}.gz`), gzipSync(payload));
}
mock.module("vinext-control-playwright", () => ({ chromium: { executablePath: () => process.execPath } }));
process.env.PLAYWRIGHT = "vinext-control-playwright";
mock.module(join(root, "scripts/app-matrix/browser.mjs"), () => ({
  async browserHost() {
    return {
      async runApp({ app, engine, record }: { app: unknown; engine: string; record(...args: unknown[]): void }) {
        record(app, engine, "playground", "install", ["bun", "install"], { status: "pass" });
        if (scenario === "after-install") throw new Error("injected failure after install");
        if (scenario === "signal") return interrupt();
        const observations = ["hmr", "reload", "counter"].map(stage => ({ stage, status: "pass" }));
        record(app, engine, "playground", "dev", [], { status: "pass", observations });
        record(app, engine, "playground", "build", [], { status: "pass" });
        record(app, engine, "playground", "start", [], { status: "pass" });
      },
      async close() { writeFileSync(join(directory, "host-closed"), "closed"); },
    };
  },
}));
async function interrupt() {
  process.kill(process.pid, "SIGTERM");
  await Bun.sleep(10000);
  throw new Error("signal did not exit the driver");
}
process.argv = [process.execPath, "vinext-probe.ts", "--web-root", assets,
  "--registry-extra", directory, "--output", join(directory, "output"),
  "--runtime-label", "host-control-not-guest-acceptance"];
await import(join(root, "scripts/app-matrix/vinext-probe.ts"));
