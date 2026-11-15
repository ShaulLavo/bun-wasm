import assert from "node:assert/strict";

for (const sync of [false, true]) {
  const path = "/missing-process-error-stack";
  const run = () => sync ? Bun.spawnSync([path], {}) : Bun.spawn([path], {});
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.name, "Error");
    assert.equal(error.message, `spawn ${path} ENOENT`);
    assert.ok("code" in error && error.code === "ENOENT");
    assert.ok("errno" in error && error.errno === -2);
    assert.ok("syscall" in error && error.syscall === "spawn");
    assert.ok("path" in error && error.path === path);
    const header = `${error.name}: ${error.message}`;
    assert.ok(error.stack?.startsWith(header));
    assert.equal(error.stack.split(header).length, 2);
    return true;
  });
}
console.log("spawn and spawnSync stacks retain the original refusal reason");
