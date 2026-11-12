import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

test.each([true, false])("owned commands preserve allowed failure stderr with inherit = %j", inherit => {
  const module = new URL("./lifetime.ts", import.meta.url).href;
  const script = `const { ownedCommand } = await import(${JSON.stringify(module)});
    const output = await ownedCommand([process.execPath, "--eval", 'console.log("fixture stdout"); console.error("fixture pre-report failure"); process.exit(1)'], undefined, 5000, ${inherit}, [0, 1]);
    console.log(JSON.stringify({ output }));`;
  const run = spawnSync(process.execPath, ["--eval", script], { encoding: "utf8", timeout: 10_000 });
  expect(run.status, run.stderr).toBe(0);
  expect(run.stdout).toBe(inherit ? 'fixture stdout\n{"output":""}\n' : '{"output":"fixture stdout\\n"}\n');
  expect(run.stderr).toBe(inherit ? "fixture pre-report failure\n" : "");
});

test("inherited command failures retain their exit code and stderr in CommandExitError", () => {
  const module = new URL("./lifetime.ts", import.meta.url).href;
  const script = `const { ownedCommand, CommandExitError } = await import(${JSON.stringify(module)});
    try { await ownedCommand([process.execPath, "--eval", 'console.error("fixture pre-report failure"); process.exit(7)'], undefined, 5000, true); }
    catch (error) { console.log(JSON.stringify({ typed: error instanceof CommandExitError, code: error.code, message: error.message })); }`;
  const run = spawnSync(process.execPath, ["--eval", script], { encoding: "utf8", timeout: 10_000 });
  expect(run.status, run.stderr).toBe(0);
  expect(JSON.parse(run.stdout)).toMatchObject({ typed: true, code: 7, message: expect.stringContaining("fixture pre-report failure") });
  expect(run.stderr).toBe("fixture pre-report failure\n");
});
