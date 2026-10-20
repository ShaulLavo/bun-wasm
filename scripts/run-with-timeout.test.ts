import { test, expect } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ownedScenario } from "./fixtures/deadline-scenario";
import { tmpdir } from "node:os";

const wrapper = join(import.meta.dir, "run-with-timeout.mts");
async function run(seconds: string, args: string[]) {
  const child = Bun.spawn(["node", wrapper, seconds, "node"].concat(args), { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, stdout, stderr };
}

test("command deadline preserves ordinary command exit and output", async () => {
  expect(await run("5", ["-e", 'console.log("ordinary-exit"); process.exit(7)'])).toEqual({ code: 7, stdout: "ordinary-exit\n", stderr: "" });
});

test("command deadline diagnoses and removes its descendant process group", async () => {
  const scratch = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "bun-wasm-deadline-"));
  try {
    const fixture = join(scratch, "deadline-fixture.ts"), pidPath = join(scratch, "pid");
    await writeFile(fixture, `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
if (process.argv[2] !== "descendant") {
  writeFileSync(process.argv[2], String(process.pid));
  spawn(process.execPath, [import.meta.filename, "descendant"], { stdio: "inherit" });
}
setInterval(() => {}, 1000);
`);
    const result = await run("1", [fixture, pidPath]);
    expect(result.code).toBe(124);
    expect(result.stderr).toContain("command deadline exceeded after 1s");
    expect(result.stderr).toContain("owned process group");
    expect(result.stderr).toContain("deadline-fixture.ts descendant");
    const pid = Number(await readFile(pidPath, "utf8"));
    const ps = Bun.spawn(["ps", "-eo", "pgid=,stat="], { stdout: "pipe" });
    const listing = await new Response(ps.stdout).text();
    expect(await ps.exited).toBe(0);
    const live = listing.trim().split("\n").filter(line => {
      const [group, state] = line.trim().split(/\s+/);
      return Number(group) === pid && !state?.startsWith("Z");
    });
    expect(live).toEqual([]);
  } finally { await rm(scratch, { recursive: true, force: true }); }
});

test("command deadline lets teardown finish before forced termination", async () => {
  const result = await run("0.2", ["-e", `process.on("SIGTERM", () => { console.log("teardown complete"); process.exit(0); }); setInterval(() => {}, 1000);`]);
  expect(result.code).toBe(124);
  expect(result.stdout).toBe("teardown complete\n");
});

test("command deadline honors descendant grace after its launcher exits and preserves unrelated processes", () => ownedScenario("launcher"), 12000);

test("ordinary launcher exit removes reparented detached descendants", () => ownedScenario("quick-launcher"), 12000);

test("Bun command deadline preserves descendant grace after launcher exit", () => ownedScenario("launcher", "bun"), 12000);
