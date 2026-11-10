import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stopProcessGroup } from "../web/tests/next-framework-process.ts";

const root = resolve(import.meta.dir, "..");
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected loopback listener");
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function until(check: () => boolean | Promise<boolean>, log: () => string): Promise<void> {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    if (await check()) return;
    await delay(10);
  }
  throw new Error(`Hot live control timed out\n${log()}`);
}

function application(port: number): string {
  return `import text from "./page.html" with { type: "text" };
const state = globalThis.hotIdentity ??= { runs: 0, server: null };
const run = ++state.runs;
const server = Bun.serve({ hostname: "127.0.0.1", port: ${port}, fetch() {
  return new Response(text, { headers: { "x-pid": String(process.pid), "x-run": String(run), "x-same-server": String(server === state.server) } });
}});
state.server ??= server;
`;
}

test("real native hot run recovers its initially malformed entry, rejects stale/deleted bytes, and releases its port", async () => {
  const scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "bun-wasm-hot-live-"));
  const port = await freePort();
  const launcher = process.env.BUN_WASM_LAUNCHER ?? join(process.env.CARGO_TARGET_DIR ?? join(root, "target"), "release/bun-wasm");
  const guest = process.env.BUN_WASM_HOT_CORE ?? join(root, "dist/bun.wasm");
  writeFileSync(join(scratch, "entry.ts"), "const invalid = ;\n");
  writeFileSync(join(scratch, "page.html"), "before");
  let child: ReturnType<typeof spawn> | undefined;
  let output = "";
  try {
    child = spawn(launcher, ["--wasm", guest, "--dir", `${scratch}::/`, "--env", "PWD=/", "--", "--hot", "run", "/entry.ts"],
      { cwd: scratch, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout?.on("data", bytes => { output += String(bytes); });
    child.stderr?.on("data", bytes => { output += String(bytes); });
    let spawnError: Error | undefined;
    child.once("error", error => { spawnError = error; });
    await until(() => Boolean(spawnError) || output.includes("SyntaxError:"), () => output);
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
    await until(() => response("before", "1"), () => output);
    rmSync(join(scratch, "page.html"));
    await until(() => output.includes("ENOENT"), () => output);
    expect(await response("before", "1")).toBe(true);
    writeFileSync(join(scratch, "page.html"), "after!");
    await until(() => response("after!", "2"), () => output);
    expect(child.exitCode).toBeNull();
  } finally {
    if (child?.pid) await stopProcessGroup(child);
    rmSync(scratch, { recursive: true, force: true });
  }
  const reusable = createServer();
  try {
    await new Promise<void>((resolve, reject) => { reusable.once("error", reject); reusable.listen(port, "127.0.0.1", resolve); });
  } finally { await new Promise<void>(resolve => reusable.close(() => resolve())); }
}, 60000);
