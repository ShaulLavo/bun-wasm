import { expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fixtureReceipt } from "../tests/package/guest-receipt-fixture";
import { quickjsPair } from "../tests/package/quickjs-plan-fixture";
import { discoverChecks, selectChecks } from "./test-checks";
import { assertLegacyCliResults, legacyCliCommand, legacyCliFixtures, legacyCliRows, prepareLegacyCli, runLegacyCli } from "./legacy-cli";

const root = resolve(import.meta.dir, "..");

function fixture(): string {
  const directory = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "bun-wasm-legacy-control-"));
  for (const folder of ["scripts", "dist", "web/scripts", "tests/servers"]) mkdirSync(join(directory, folder), { recursive: true });
  for (const file of ["run-with-timeout.mts", "linux-subreaper.mts", "process-owner.mts"]) copyFileSync(join(root, "scripts", file), join(directory, "scripts", file));
  for (const file of ["http.ts", "tls-fixtures.ts"]) copyFileSync(join(root, "tests/servers", file), join(directory, "tests/servers", file));
  copyFileSync(join(root, "scripts/fixtures/legacy-cli-consumer.ts"), join(directory, "web/scripts/run.ts"));
  const { core, side } = quickjsPair();
  writeFileSync(join(directory, "dist/bun.wasm"), core);
  writeFileSync(join(directory, "dist/quickjs.wasm"), side);
  writeFileSync(join(directory, "dist/bun.wasm.build.json"), JSON.stringify(fixtureReceipt(core, "quickjs", side)));
  for (const name of legacyCliFixtures) {
    const path = join(directory, "tests/fixtures", name);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "index.js"), `${name} \n\n`);
    writeFileSync(join(path, "expected.txt"), `ok ${name} stderr\n`);
  }
  return directory;
}

test("the functional helper executes the exact ordered command matrix with one loopback server and merged output", async () => {
  const directory = fixture();
  const previous = process.env.BUN_WASM_TEST_TMP;
  process.env.BUN_WASM_TEST_TMP = directory;
  try {
    const results = await runLegacyCli(directory);
    expect(results).toEqual(legacyCliRows.map(row => ({ id: row.id, status: 0, matches: true })));
    const records: unknown[] = readFileSync(join(directory, "rows.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(records).toHaveLength(14);
    const servers = new Set();
    records.forEach((record, index) => {
      const row = legacyCliRows[index]!;
      expect(record).toEqual({ args: [join(directory, "dist/bun.wasm"), "-e", `${row.fixture} `], cwd: join(directory, "web"), slots: row.slots, server: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/) });
      if (record && typeof record === "object" && "server" in record) servers.add(record.server);
    });
    expect(servers.size).toBe(1);
    const server = Array.from(servers)[0];
    expect(typeof server).toBe("string");
    if (typeof server !== "string") throw new Error("Missing test server");
    await expect(fetch(server)).rejects.toThrow();
    expect(readdirSync(directory).filter(path => path.startsWith("bun-wasm-legacy-cli-"))).toEqual([]);
    writeFileSync(join(directory, "fail-exit"), "net-fetch/table");
    writeFileSync(join(directory, "tests/fixtures/net-serve/expected.txt"), "wrong output\n");
    await expect(runLegacyCli(directory)).rejects.toThrow("failed 3/14 rows: net-fetch/table, net-serve/table, net-serve/imports");
    expect(readFileSync(join(directory, "rows.jsonl"), "utf8").trim().split("\n")).toHaveLength(28);
    expect(readdirSync(directory).filter(path => path.startsWith("bun-wasm-legacy-cli-"))).toEqual([]);
  } finally {
    if (previous === undefined) delete process.env.BUN_WASM_TEST_TMP;
    else process.env.BUN_WASM_TEST_TMP = previous;
    rmSync(directory, { recursive: true, force: true });
  }
}, 120_000);

test("interruption drains the active consumer and loopback server before removing owned scratch", async () => {
  const directory = fixture();
  writeFileSync(join(directory, "hang"), "");
  writeFileSync(join(directory, "runner.ts"), `import { runLegacyCli } from ${JSON.stringify(join(root, "scripts/legacy-cli.ts"))}; await runLegacyCli(${JSON.stringify(directory)});`);
  const child = Bun.spawn(["bun", join(directory, "runner.ts")], { env: { ...process.env, BUN_WASM_TEST_TMP: directory }, stdout: "ignore", stderr: "ignore" });
  try {
    await waitForRow(directory, child);
    child.kill("SIGTERM");
    expect(await child.exited).not.toBe(0);
    const record: unknown = JSON.parse(readFileSync(join(directory, "rows.jsonl"), "utf8").trim());
    if (!record || typeof record !== "object" || !("server" in record) || typeof record.server !== "string") throw new Error("Missing server record");
    await expect(fetch(record.server)).rejects.toThrow();
    expect(readdirSync(directory).filter(path => path.startsWith("bun-wasm-legacy-cli-"))).toEqual([]);
  } finally {
    child.kill("SIGTERM");
    await child.exited;
    rmSync(directory, { recursive: true, force: true });
  }
}, 120_000);

async function waitForRow(directory: string, child: ReturnType<typeof Bun.spawn>): Promise<void> {
  const timeout = setTimeout(() => child.kill("SIGTERM"), 60_000);
  try {
    while (!existsSync(join(directory, "rows.jsonl"))) {
      if (child.exitCode !== null) throw new Error("Control exited before its first row");
      await Bun.sleep(20);
    }
  } finally { clearTimeout(timeout); }
}

test("missing selected files and invalid guest/companion receipts fail before any row starts", async () => {
  const directory = fixture();
  try {
    for (const path of ["dist/bun.wasm", "dist/quickjs.wasm", "dist/bun.wasm.build.json", "web/scripts/run.ts", "tests/fixtures/net-fetch/index.js", "tests/fixtures/net-ws-builtin/expected.txt"]) {
      const file = join(directory, path);
      const bytes = readFileSync(file);
      rmSync(file);
      await expect(runLegacyCli(directory)).rejects.toThrow("Missing required legacy CLI input");
      writeFileSync(file, bytes);
    }
    writeFileSync(join(directory, "dist/quickjs.wasm"), quickjsPair("jsc").side);
    await expect(prepareLegacyCli(directory)).rejects.toThrow();
    writeFileSync(join(directory, "dist/quickjs.wasm"), quickjsPair().side);
    writeFileSync(join(directory, "dist/bun.wasm.build.json"), "{}");
    await expect(prepareLegacyCli(directory)).rejects.toThrow("Invalid guest build receipt");
    expect(existsSync(join(directory, "rows.jsonl"))).toBe(false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("row accounting rejects missing, duplicate, reordered, failed and mismatched results", () => {
  const complete = legacyCliRows.map(row => ({ id: row.id, status: 0, matches: true }));
  assertLegacyCliResults(complete);
  for (const rows of [[], complete.slice(1), complete.slice(1).concat([complete[1]!]), complete.toReversed(), complete.concat([complete[0]!])]) expect(() => assertLegacyCliResults(rows)).toThrow("row accounting");
  expect(() => assertLegacyCliResults(complete.map((row, index) => index === 0 ? { ...row, status: 9 } : row))).toThrow("failed 1/14");
  expect(() => assertLegacyCliResults(complete.map((row, index) => index === 0 ? { ...row, matches: false } : row))).toThrow("failed 1/14");
});

test("discovery gives the live rows exactly one runtime owner and the local entrypoint uses the same helper", () => {
  const checks = discoverChecks(root);
  const path = "scripts/legacy-cli-runtime.test.ts";
  expect(checks.filter(check => check.path === path).map(check => check.owner)).toEqual(["runtime"]);
  expect(selectChecks("runtime", checks).filter(check => check === path)).toHaveLength(1);
  expect(selectChecks("local-runtime", checks).filter(check => check === path)).toHaveLength(1);
  const local = readFileSync(join(root, "scripts/test-web.sh"), "utf8");
  expect(local.match(/bun "\$root\/scripts\/legacy-cli.ts"/g)).toHaveLength(1);
  expect(local).not.toContain("for slots in table imports");
  expect(local).not.toContain("bun scripts/run.ts");
  const directory = fixture();
  try {
    expect(legacyCliCommand(directory, legacyCliRows[0]!)).toEqual(["node", join(directory, "scripts/run-with-timeout.mts"), "60", "bun", "scripts/run.ts", join(directory, "dist/bun.wasm"), "-e", "net-fetch "]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
