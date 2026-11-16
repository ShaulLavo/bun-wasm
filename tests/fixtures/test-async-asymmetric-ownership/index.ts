import { expect } from "bun:test";

function run(file: string, reject = false) {
  const result = Bun.spawnSync([process.execPath, "test", `./${file}.test.ts`], {
    env: { ...process.env, AGENT: "0", CI: "false", REJECT_MATCHER: reject ? "1" : "0" },
  });
  return { code: result.exitCode, text: result.stderr.toString() };
}

const success = run("success");
expect(success.code).toBe(0);
expect(success.text).toContain("50 pass");
console.log("PASS unawaited successes across all consumers");

for (const reject of [false, true]) {
  const result = run("failure", reject);
  const names = new Set(Array.from(result.text.matchAll(/^\(fail\) ([^\n]+)/gm), match => match[1]));
  expect(result.code).toBe(1);
  expect(names.size).toBe(49);
  expect(names.has("next invocation stays clean")).toBe(false);
  expect(result.text).not.toContain("Unhandled error between tests");
  expect(result.text).not.toMatch(/^ \d+ errors?$/m);
  if (reject) expect(Array.from(result.text.matchAll(/^error: owned matcher reason$/gm)).length).toBe(49);
  console.log(`PASS unawaited ${reject ? "rejection" : "false"} belongs to each invocation`);
}

const late = run("late");
expect(late.code).toBe(1);
expect(late.text).toContain("(pass) late continuations leave the next case untouched");
expect(late.text).not.toContain("Unhandled error between tests");
console.log("PASS late snapshot and modifier settlement stays isolated");

const order = run("order");
expect(order.code).toBe(0);
expect(order.text).toContain("2 pass");
console.log("PASS snapshot identity follows call order");

const rejection = run("rejection");
expect(rejection.code).toBe(0);
expect(rejection.text).toContain("2 pass");
expect(Array.from(rejection.text.matchAll(/^error: owned Error rejection$/gm)).length).toBe(1);
expect(rejection.text).not.toContain("Unhandled error between tests");
console.log("PASS Error rejection wrapper and direct throw identity");
