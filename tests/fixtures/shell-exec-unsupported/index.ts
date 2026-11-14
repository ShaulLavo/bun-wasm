import assert from "node:assert/strict";

function shell(command: string) {
  return Bun.spawnSync(["/bin/bash", "-c", command], {
    cwd: "/",
    env: { ...process.env, EXEC_MARK: "inherited" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
}

const ordinary = shell("/bin/node /child.ts tail");
assert.equal(ordinary.exitCode, 17, ordinary.stderr.toString());
assert.equal(ordinary.stdout.toString(), "inherited tail root-access\n");
assert.equal(ordinary.stderr.toString(), "");

const explicit = shell("exec /bin/node /child.ts explicit; echo unreachable");
assert.equal(explicit.exitCode, 126, explicit.stderr.toString());
assert.equal(explicit.stdout.toString(), "");
assert.ok(explicit.stderr.toString().includes("not supported"), explicit.stderr.toString());

const later = shell("echo shell-still-works");
assert.equal(later.exitCode, 0, later.stderr.toString());
assert.equal(later.stdout.toString(), "shell-still-works\n");
console.log("unsupported exec preserves ordinary spawn and explicit status 126");
