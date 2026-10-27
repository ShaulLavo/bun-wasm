import { guestBuilds } from "./guest-source-manifest";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { verifyGuestBuildReceipt, verifyGuestCompanions } from "./guest-build-receipt";

const root = resolve(import.meta.dir, "..");
export const webGuestArtifacts = {
  quickjs: "bun.wasm",
  browser: "bun-browser.wasm",
  jsc: "bun-jsc.wasm",
} as const;
type WebGuestEngine = keyof typeof webGuestArtifacts;

export function webGuestEngines(args: readonly string[]): WebGuestEngine[] {
  const engines: WebGuestEngine[] = [];
  for (const arg of args) {
    if (arg !== "quickjs" && arg !== "browser" && arg !== "jsc") throw new Error(`Unknown guest test group: ${arg}`);
    if (engines.includes(arg)) throw new Error(`Duplicate guest test group: ${arg}`);
    engines.push(arg);
  }
  if (!engines.length) throw new Error("Usage: test-web-guests.ts <quickjs|browser|jsc> [...]");
  return engines;
}

async function fixture(directory: string, artifact: string) {
  const path = join(directory, "dist", artifact);
  const file = Bun.file(path);
  if (!await file.exists()) throw new Error(`Missing required Web guest fixture: ${path}`);
  const sidecar = Bun.file(`${path}.build.json`);
  if (!await sidecar.exists()) throw new Error(`Missing required Web guest receipt: ${path}.build.json`);
  const receipt: unknown = await sidecar.json();
  verifyGuestBuildReceipt(await file.bytes(), receipt);
  if (guestBuilds[receipt.sourceManifest.build].artifact !== artifact) throw new Error(`Web guest engine mismatch: ${artifact}`);
  await verifyGuestCompanions(receipt, join(directory, "dist"));
  return { path, ...receipt };
}

export async function prepareWebGuestFixtures(directory: string, engine: WebGuestEngine) {
  const guest = await fixture(directory, webGuestArtifacts[engine]);
  const tools = await fixture(directory, "bun-tools.wasm");
  for (const field of ["bunHead", "bunTree", "sysrootReceiptSha256"] as const) {
    if (guest[field] !== tools[field]) throw new Error(`Web guest/tools fixture mismatch: ${field}`);
  }
  return { engine, guest, tools };
}

if (import.meta.main) {
  const engines = webGuestEngines(process.argv.slice(2));
  const fixtures = [];
  for (const engine of engines) fixtures.push(await prepareWebGuestFixtures(root, engine));
  const source = spawnSync("git", ["rev-parse", "HEAD", "HEAD^{tree}"], { cwd: root, encoding: "utf8" });
  if (source.status !== 0) throw new Error(`Cannot identify guest test source: ${source.stderr}`);
  console.log(JSON.stringify({ source: source.stdout.trim().split("\n"), fixtures }, null, 2));
  const files = engines.map(engine => join(root, "web/guest-tests", `${engine}.test.ts`));
  const child = Bun.spawn(["bun", "test"].concat(files), {
    cwd: root, stdin: "inherit", stdout: "inherit", stderr: "inherit",
    env: { ...process.env, BUN_WASM_TEST_BROWSER_WASM: join(root, "dist/bun-browser.wasm") },
  });
  const stop = () => child.kill("SIGTERM");
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try { process.exitCode = await child.exited; }
  finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}
