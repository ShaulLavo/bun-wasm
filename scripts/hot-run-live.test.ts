import { expect, setDefaultTimeout, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stopProcessGroup } from "../web/tests/next-framework-process.ts";

// Tests here start real processes or browsers. The limit only catches a hang.
setDefaultTimeout(120_000);

const root = resolve(import.meta.dir, "..");
const testTimeoutMs = 60_000;

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected loopback listener");
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}
function application(port: number, specifier = "./page.html"): string {
  return `import text from ${JSON.stringify(specifier)} with { type: "text" };
const state = globalThis.hotIdentity ??= { runs: 0, server: null };
const run = ++state.runs;
const server = Bun.serve({ hostname: "127.0.0.1", port: ${port}, fetch() {
  return new Response(text, { headers: { "x-pid": String(process.pid), "x-run": String(run), "x-same-server": String(server === state.server) } });
}});
state.server ??= server;
`;
}

test("real native hot run recovers its initially malformed entry, rejects stale/deleted bytes, and releases its port", async () => {
  // Cold Wasmtime compilation shares the test budget with recovery. Leave time to stop the process group.
  const deadline = performance.now() + testTimeoutMs - 15_000;
  const scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "bun-wasm-hot-live-"));
  const port = await freePort();
  const launcher = process.env.BUN_WASM_LAUNCHER ?? join(process.env.CARGO_TARGET_DIR ?? join(root, "target"), "release/bun-wasm");
  const guest = process.env.BUN_WASM_HOT_CORE ?? join(root, "dist/bun.wasm");
  writeFileSync(join(scratch, "entry.ts"), "const invalid = ;\n");
  writeFileSync(join(scratch, "page.html"), "before");
  let child: ReturnType<typeof spawn> | undefined;
  let output = "";
  async function waitFor(phase: string, check: () => boolean | Promise<boolean>): Promise<void> {
    while (performance.now() < deadline) {
      if (await check()) return;
      await Bun.sleep(10);
    }
    throw new Error(`Hot live control timed out waiting for ${phase}\n${output}`);
  }
  try {
    child = spawn(launcher, ["--wasm", guest, "--dir", `${scratch}::/`, "--env", "PWD=/", "--", "--hot", "run", "/entry.ts"],
      { cwd: scratch, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout?.on("data", bytes => { output += String(bytes); });
    child.stderr?.on("data", bytes => { output += String(bytes); });
    let spawnError: Error | undefined;
    child.once("error", error => { spawnError = error; });
    await waitFor("initial syntax error", () => Boolean(spawnError) || output.includes("SyntaxError:"));
    if (spawnError) throw spawnError;
    expect(child.exitCode).toBeNull();
    expect(output.match(/SyntaxError:/g)).toHaveLength(1);
    writeFileSync(join(scratch, "entry.ts"), application(port));
    const address = `http://127.0.0.1:${port}/`;
    let pid = "";
    async function response(body: string, run: string): Promise<boolean> {
      try {
        const result = await fetch(address, { headers: { connection: "close" }, signal: AbortSignal.timeout(1000) });
        const actual = await result.text();
        if (actual !== body || result.headers.get("x-run") !== run) return false;
        pid ||= result.headers.get("x-pid") ?? "";
        expect(result.headers.get("x-pid")).toBe(pid);
        expect(result.headers.get("x-same-server")).toBe("true");
        return true;
      } catch { return false; }
    }
    await waitFor("first served page", () => response("before", "1"));
    rmSync(join(scratch, "page.html"));
    await waitFor("deleted page error", () => output.includes("ENOENT") || output.includes("Cannot find module './page.html'"));
    expect(await response("before", "1")).toBe(true);
    writeFileSync(join(scratch, "page.html"), "after!");
    await waitFor("restored page", () => response("after!", "2"));
    writeFileSync(join(scratch, "entry.ts"), application(port, "./later"));
    await waitFor("unresolved import error", () => output.includes("Cannot find module './later'"));
    expect(await response("after!", "2")).toBe(true);
    writeFileSync(join(scratch, "later.ts"), "extensionless");
    await waitFor("restored extensionless import", () => response("extensionless", "3"));
    expect(child.exitCode).toBeNull();
  } finally {
    if (child?.pid) await stopProcessGroup(child);
    rmSync(scratch, { recursive: true, force: true });
  }
  const reusable = createServer();
  try {
    await new Promise<void>((resolve, reject) => { reusable.once("error", reject); reusable.listen(port, "127.0.0.1", resolve); });
  } finally { await new Promise<void>(resolve => reusable.close(() => resolve())); }
}, testTimeoutMs);
