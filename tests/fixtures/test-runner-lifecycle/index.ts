import assert from "node:assert/strict";

for (const [file, passes, failures] of [["lifecycle.test.ts", 9, 0], ["failure.test.ts", 0, 5], ["failing-cleanup.test.ts", 2, 2]] as const) {
  const child = Bun.spawnSync([process.execPath, "test", `./${file}`], {
    stdout: "pipe", stderr: "pipe", env: { ...process.env, AGENT: "0", NO_COLOR: "1" },
  });
  const stderr = child.stderr.toString();
  assert.equal(child.exitCode, failures ? 1 : 0, stderr);
  assert.match(stderr, new RegExp(` ${passes} pass\\n`));
  assert.match(stderr, new RegExp(` ${failures} fail\\n`));
  if (!failures) assert.match(stderr, /\(attempt 3\)/);
  if (file === "failing-cleanup.test.ts") assert.equal(stderr.match(/^error: xfail cleanup /gm)?.length, 4);
  console.log(child.stdout.toString().trim());
  console.log(`${file}: ${passes} pass, ${failures} fail`);
}
