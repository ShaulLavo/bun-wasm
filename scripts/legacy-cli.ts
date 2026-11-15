import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, lstatSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { verifyGuestBuildReceipt, verifyGuestCompanions } from "./guest-build-receipt";

export const legacyCliFixtures = ["net-fetch", "net-serve", "net-node-http", "net-tcp", "net-bun-tcp", "net-http-upgrade", "net-ws-builtin"] as const;
const slotModes = ["table", "imports"] as const;
export const legacyCliRows = slotModes.flatMap(slots => legacyCliFixtures.map(fixture => ({ id: `${fixture}/${slots}`, fixture, slots })));
type Row = typeof legacyCliRows[number];
export type LegacyCliResult = { id: string; status: number; matches: boolean };

function requiredFile(path: string): void {
  if (!lstatSync(path, { throwIfNoEntry: false })?.isFile()) throw new Error(`Missing required legacy CLI input: ${path}`);
}

export async function prepareLegacyCli(directory: string): Promise<void> {
  for (const path of ["dist/bun.wasm", "dist/quickjs.wasm", "dist/bun.wasm.build.json", "web/scripts/run.ts", "tests/servers/http.ts", "scripts/run-with-timeout.mts"]) requiredFile(join(directory, path));
  for (const fixture of legacyCliFixtures) {
    for (const file of ["index.js", "expected.txt"]) requiredFile(join(directory, "tests/fixtures", fixture, file));
  }
  const receipt: unknown = await Bun.file(join(directory, "dist/bun.wasm.build.json")).json();
  verifyGuestBuildReceipt(await Bun.file(join(directory, "dist/bun.wasm")).bytes(), receipt);
  if (receipt.sourceManifest.build !== "quickjs" || receipt.program.kind !== "quickjs" || receipt.profile !== undefined) throw new Error("Legacy CLI requires the ordinary split QuickJS producer");
  await verifyGuestCompanions(receipt, join(directory, "dist"));
}

export function legacyCliCommand(directory: string, row: Row): string[] {
  // Shell command substitution strips trailing newlines, but retains other whitespace.
  const source = readFileSync(join(directory, "tests/fixtures", row.fixture, "index.js"), "utf8").replace(/\n+$/, "");
  return ["node", join(directory, "scripts/run-with-timeout.mts"), "60", "bun", "scripts/run.ts", join(directory, "dist/bun.wasm"), "-e", source];
}

export function assertLegacyCliResults(results: readonly LegacyCliResult[]): void {
  if (results.length !== 14 || legacyCliRows.some((row, index) => row.id !== results[index]?.id)) throw new Error("Incomplete legacy CLI row accounting: expected all 14 ordered, unique rows");
  const failed = results.filter(result => result.status !== 0 || !result.matches);
  if (failed.length) throw new Error(`Legacy CLI failed ${failed.length}/14 rows: ${failed.map(row => row.id).join(", ")}`);
}

function completion(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", code => resolve(code ?? 1));
  });
}

async function serverAddress(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => finish(new Error("Legacy CLI loopback server startup hung after 60 seconds")), 60_000);
    const exited = () => finish(new Error("Legacy CLI loopback server exited before printing its port"));
    const data = (chunk: Buffer) => {
      output += chunk.toString();
      if (!output.includes("\n")) return;
      const port = Number(output.split("\n")[0]);
      finish(Number.isInteger(port) && port > 0 && port <= 65535 ? `http://127.0.0.1:${port}` : new Error("Invalid legacy CLI loopback server port"));
    };
    function finish(value: string | Error) {
      clearTimeout(timer);
      child.removeListener("exit", exited);
      child.removeListener("error", finish);
      child.stdout?.removeListener("data", data);
      if (value instanceof Error) reject(value);
      else resolve(value);
    }
    child.once("error", finish);
    child.once("exit", exited);
    child.stdout?.on("data", data);
  });
}

async function runRow(directory: string, row: Row, output: string, env: NodeJS.ProcessEnv, track: (child: ChildProcess) => void): Promise<LegacyCliResult> {
  const [command, ...args] = legacyCliCommand(directory, row);
  if (!command) throw new Error("Missing legacy CLI command");
  const fd = openSync(output, "w");
  let status: number;
  try {
    const child = spawn(command, args, { cwd: join(directory, "web"), env: { ...env, SLOTS: row.slots }, stdio: ["ignore", fd, fd] });
    track(child);
    status = await completion(child);
  } finally { closeSync(fd); }
  const actual = readFileSync(output);
  const expected = readFileSync(join(directory, "tests/fixtures", row.fixture, "expected.txt"));
  const matches = actual.equals(expected);
  console.log(`${status === 0 && matches ? "ok  " : "FAIL"} cli ${row.fixture} (${row.slots})`);
  if (status !== 0 || !matches) console.error(`exit ${status}\nexpected:\n${expected.toString()}actual merged stdout/stderr:\n${actual.toString()}`);
  return { id: row.id, status, matches };
}

export async function runLegacyCli(directory: string): Promise<LegacyCliResult[]> {
  await prepareLegacyCli(directory);
  const scratch = mkdtempSync(join(process.env.BUN_WASM_TEST_TMP ?? process.env.TMPDIR ?? tmpdir(), "bun-wasm-legacy-cli-"));
  let active: ChildProcess | undefined;
  let interrupted = false;
  // The existing supervisor owns the server's descendants and drains them on signals.
  const server = spawn("node", [join(directory, "scripts/run-with-timeout.mts"), "1200", "bun", join(directory, "tests/servers/http.ts")], { cwd: directory, stdio: ["ignore", "pipe", "inherit"] });
  const serverDone = completion(server);
  void serverDone.catch(() => {});
  const stop = () => { interrupted = true; active?.kill("SIGTERM"); server.kill("SIGTERM"); };
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  for (const signal of signals) process.on(signal, stop);
  try {
    const env = { ...process.env, TEST_SERVER: await serverAddress(server) };
    const results: LegacyCliResult[] = [];
    for (const row of legacyCliRows) {
      if (interrupted || server.exitCode !== null || server.signalCode !== null) throw new Error("Legacy CLI interrupted or loopback server exited");
      results.push(await runRow(directory, row, join(scratch, `${row.id.replace("/", "-")}.out`), env, child => { active = child; }));
    }
    assertLegacyCliResults(results);
    return results;
  } finally {
    server.kill("SIGTERM");
    try { await serverDone; }
    finally {
      for (const signal of signals) process.removeListener(signal, stop);
      rmSync(scratch, { recursive: true, force: true });
    }
  }
}

if (import.meta.main) await runLegacyCli(resolve(import.meta.dir, ".."));
