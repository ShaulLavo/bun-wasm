import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join } from "node:path";

const root = fs.mkdtempSync("fs-fdatasync-and-fds-");
try {
  // fdatasync / fsync bad fd reports EBADF and fdatasync includes fd.
  let badErr: (Error & { code?: string; fd?: number }) | undefined;
  try {
    await (fs.promises as unknown as { fdatasync(fd: number): Promise<void> }).fdatasync(50000);
  } catch (err) {
    badErr = err as Error & { code?: string; fd?: number };
  }
  assert.equal(badErr?.code, "EBADF");
  assert.equal(badErr?.fd, 50000);
  assert.throws(() => fs.fsyncSync(50000), { code: "EBADF", syscall: "fsync" });

  // Valid writable fd succeeds for both fsync and fdatasync.
  const syncPath = join(root, "sync.txt");
  const syncFd = fs.openSync(syncPath, "w+");
  try {
    fs.writeSync(syncFd, "ok");
    fs.fdatasyncSync(syncFd);
    fs.fsyncSync(syncFd);
  } finally {
    fs.closeSync(syncFd);
  }

  // readFileSync honors flags.
  for (const flag of ["a+", "as+", "w+", "wx+"]) {
    const file = join(root, `${flag.replace("+", "_plus")}.txt`);
    assert.equal(fs.readFileSync(file, { encoding: "utf8", flag }), "");
    assert.equal(fs.readFileSync(file, "utf8"), "");
  }
  assert.throws(() => fs.readFileSync(join(root, "w_only.txt"), { encoding: "utf8", flag: "w" }), { code: "EBADF" });

  // copyFileSync and promises.copyFile errors include path and dest.
  const missingDest = join(root, "missing-dir", "out.txt");
  assert.throws(() => fs.copyFileSync(syncPath, missingDest), {
    code: "ENOENT",
    syscall: "copyfile",
    path: syncPath,
    dest: missingDest,
  });
  await assert.rejects(fs.promises.copyFile(syncPath, missingDest), {
    code: "ENOENT",
    syscall: "copyfile",
    path: syncPath,
    dest: missingDest,
  });

  // rm and promises.rm report ERR_FS_EISDIR for directories without recursive.
  const sub = join(root, "sub");
  fs.mkdirSync(sub);
  await assert.rejects(fs.promises.rm(sub), { code: "ERR_FS_EISDIR" });
  const rmErr = await new Promise<NodeJS.ErrnoException | null>(resolve => fs.rm(sub, resolve));
  assert.equal(rmErr?.code, "ERR_FS_EISDIR");

  // closeSync(2) actually closes fd 2, rejects double close with EBADF, and allows redirect.
  const redirected = join(root, "redirected.txt");
  const redirectScript = join(root, "redirect.mjs");
  fs.writeFileSync(
    redirectScript,
    `
      import fs from "node:fs";
      fs.writeSync(2, "PRE.");
      fs.closeSync(2);
      let second = "no-throw";
      try { fs.closeSync(2); } catch (e) { second = e.code; }
      const fd = fs.openSync(process.argv[2], "w");
      process.stdout.write(fd + ":" + second);
      fs.writeSync(2, "POST.");
    `,
  );
  const proc = Bun.spawn({
    cmd: [process.execPath, redirectScript, redirected],
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  assert.equal(exitCode, 0);
  assert.equal(stdout, "2:EBADF");
  assert.equal(stderr, "PRE.");
  assert.equal(fs.readFileSync(redirected, "utf8"), "POST.");

  console.log("fs fdatasync and fds ok");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
