// The bun subcommands a Bun author types first, run offline (docs/bun-api-probe.md).
// Each check prints one line.
async function check(name: string, body: () => unknown): Promise<void> {
  try {
    const value = await body();
    console.log(`ok ${name}${value === undefined ? "" : ": " + (typeof value === "string" ? value : Bun.inspect(value))}`);
  } catch (error) {
    console.log(`FAIL ${name}: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
  }
}
function bun(args: string[], options: { cwd?: string; stdin?: string } = {}) {
  const result = Bun.spawnSync([process.execPath, ...args], { cwd: options.cwd, stdin: options.stdin === undefined ? "ignore" : new TextEncoder().encode(options.stdin), env: { ...process.env, NO_COLOR: "1" } });
  const out = result.stdout.toString().trim();
  const err = result.stderr.toString().trim();
  if (result.exitCode !== 0) throw new Error(`exit ${result.exitCode}: ${err || out}`);
  return out;
}

await check("bun --version", () => /^\d+\.\d+\.\d+/.test(bun(["--version"])));
await check("bun --revision", () => bun(["--revision"]).length > 0);
await check("bun -e", () => bun(["-e", "console.log(1 + 1, typeof Bun)"]));
await check("bun -p", () => bun(["-p", "[1, 2].map(x => x * 2)"]));
await check("bun run script", async () => {
  await Bun.write("app/package.json", JSON.stringify({ name: "app", scripts: { hello: "echo hello from script", chain: "bun run hello && echo chained" } }));
  return [bun(["run", "hello"], { cwd: "app" }), bun(["run", "chain"], { cwd: "app" }).split("\n").pop()];
});
await check("bun <file>", async () => {
  await Bun.write("app/hi.ts", `const n: number = 3; console.log("hi", n);\n`);
  return bun(["hi.ts"], { cwd: "app" });
});
await check("bun run - (stdin)", () => bun(["run", "-"], { stdin: "console.log('from stdin script')" }));
// bun init installs @types/bun from the registry: the playground runner covers it with --network.
await check("bun test filter", async () => {
  await Bun.write("tests/math.test.ts", `import { test, expect } from "bun:test";\ntest("one", () => expect(1).toBe(1));\ntest("two", () => expect(2).toBe(2));\n`);
  const result = Bun.spawnSync([process.execPath, "test", "-t", "two"], { cwd: "tests", env: { ...process.env, NO_COLOR: "1" } });
  const report = result.stderr.toString();
  return [result.exitCode, /1 pass/.test(report), /1 filtered out|filtered/.test(report) || /Ran 1 test/.test(report)];
});
await check("bun test failure exit", async () => {
  await Bun.write("failing/fail.test.ts", `import { test, expect } from "bun:test";\ntest("fails", () => expect(1).toBe(2));\n`);
  const result = Bun.spawnSync([process.execPath, "test"], { cwd: "failing", env: { ...process.env, NO_COLOR: "1" } });
  const report = result.stderr.toString();
  return [result.exitCode, report.includes("Expected: 2"), report.includes("Received: 1"), /1 fail/.test(report)];
});
await check("bun build --target=bun", async () => {
  await Bun.write("app/entry.ts", `export const x: number = 1; console.log("built", x);\n`);
  bun(["build", "entry.ts", "--target=bun", "--outfile=out.js"], { cwd: "app" });
  return bun(["out.js"], { cwd: "app" });
});
await check("bun --help", () => bun(["--help"]).includes("Usage"));
await check("unknown command message", () => {
  const result = Bun.spawnSync([process.execPath, "nonexistent-script-name"], { env: { ...process.env, NO_COLOR: "1" } });
  return [result.exitCode !== 0, /not found|Script not found|could not find/i.test(result.stderr.toString())];
});
