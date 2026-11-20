import { test, expect, setDefaultTimeout } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ownedScenario } from "./fixtures/deadline-scenario";
import { tmpdir } from "node:os";

// Tests here start real processes or browsers. The limit only catches a hang.
setDefaultTimeout(120_000);

const wrapper = join(import.meta.dir, "run-with-timeout.mts");
async function run(seconds: string, args: string[]) {
  const child = Bun.spawn(["node", wrapper, seconds, "node"].concat(args), { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, stdout, stderr };
}

test("command deadline preserves ordinary command exit and output", async () => {
  expect(await run("5", ["-e", 'console.log("ordinary-exit"); process.exit(7)'])).toEqual({ code: 7, stdout: "ordinary-exit\n", stderr: "" });
});

test("until-exit supervision retains command status without replacing file-owned hang caps", async () => {
  expect(await run("--until-exit", ["-e", 'console.log("file-owned-caps"); process.exit(11)'])).toEqual({ code: 11, stdout: "file-owned-caps\n", stderr: "" });
  const invalid = await run("0", ["-e", 'console.log("must not start")']);
  expect(invalid.code).not.toBe(0);
  expect(invalid.stdout).toBe("");
  expect(invalid.stderr).toContain("Usage:");
});

test.skipIf(process.platform !== "linux")("Node-entered numeric supervision reaps orphans while its command is still running", async () => {
  const result = await run("30", ["-e", `
const { spawn } = require("node:child_process");
const { existsSync, readFileSync } = require("node:fs");
const owned = [];
const launcher = spawn(process.execPath, ["-e", 'const {spawn}=require("node:child_process"); const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"}); child.unref(); console.log(child.pid);'], {stdio:["ignore","pipe","inherit"]});
launcher.stdout.on("data", bytes => owned.push(Number(String(bytes).trim())));
launcher.once("close", async () => {
  try {
    const pid = owned[0];
    if (!pid) throw new Error("missing orphan PID");
    process.kill(pid, "SIGKILL");
    const deadline = Date.now() + 10000;
    while (existsSync("/proc/" + pid)) {
      if (Date.now() >= deadline) throw new Error("owned orphan remains " + readFileSync("/proc/" + pid + "/stat", "utf8"));
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    console.log("orphan fully reaped before command exit");
    process.exitCode = 7;
  } catch (error) { console.error(error); process.exitCode = 1; }
});
`]);
  expect(result.code, result.stderr).toBe(7);
  expect(result.stdout).toBe("orphan fully reaped before command exit\n");
}, 40000);

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

test("Bun ordinary launcher exit removes reparented detached descendants", () => ownedScenario("quick-launcher", "bun"), 12000);

for (const runtime of ["node", "bun"] as const) {
  test(`${runtime} deadline grace does not depend on worker browser import startup`, () => ownedScenario("launcher", runtime, undefined, {
    NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${new URL("./fixtures/deadline-worker-import-control.ts", import.meta.url).href}`].filter(Boolean).join(" "),
  }), 12000);
}
