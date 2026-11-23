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

  // Valid writable and read-only fds succeed for both fsync and fdatasync (including FileHandle).
  const syncPath = join(root, "sync.txt");
  const syncFd = fs.openSync(syncPath, "w+");
  try {
    fs.writeSync(syncFd, "ok");
    fs.fdatasyncSync(syncFd);
    fs.fsyncSync(syncFd);
  } finally {
    fs.closeSync(syncFd);
  }
  const roFd = fs.openSync(syncPath, "r");
  try {
    fs.fdatasyncSync(roFd);
    fs.fsyncSync(roFd);
  } finally {
    fs.closeSync(roFd);
  }
  const roHandle = await fs.promises.open(syncPath, "r");
  try {
    await roHandle.datasync();
    await roHandle.sync();
  } finally {
    await roHandle.close();
  }

  // Stdio fsync/fdatasync never throw EBADF: file-backed streams succeed and pipes throw EINVAL.
  for (const [label, fn] of [
    ["fsync(1)", () => fs.fsyncSync(1)],
    ["fdatasync(2)", () => fs.fdatasyncSync(2)],
  ] as const) {
    try {
      fn();
    } catch (err) {
      assert.equal((err as NodeJS.ErrnoException).code, "EINVAL", `${label} should succeed or throw EINVAL`);
    }
  }
  const stdioScript = join(root, "stdio-sync.mjs");
  fs.writeFileSync(
    stdioScript,
    `
      import fs from "node:fs";
      const out = [];
      for (const [name, fn] of [["fsync1", () => fs.fsyncSync(1)], ["fdatasync2", () => fs.fdatasyncSync(2)]]) {
        try { fn(); out.push(name + ":OK"); }
        catch (e) { out.push(name + ":" + e.code + ":" + e.syscall + ":" + String(e.fd)); }
      }
      process.stdout.write(out.join(","));
    `,
  );
  const stdioProc = Bun.spawn({
    cmd: [process.execPath, stdioScript],
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdioOut, stdioExit] = await Promise.all([
    new Response(stdioProc.stdout).text(),
    stdioProc.exited,
  ]);
  assert.equal(stdioExit, 0);
  assert.equal(stdioOut, "fsync1:EINVAL:fsync:undefined,fdatasync2:EINVAL:fdatasync:2");

  // Non-integer and out-of-range fds throw ERR_OUT_OF_RANGE before any syscall (preserving fd 3).
  for (const fn of [
    () => fs.closeSync(3.5),
    () => fs.closeSync(-1),
    () => fs.writeSync(3.5, "x"),
    () => fs.ftruncateSync(3.5),
    () => fs.fchownSync(3.5, 0, 0),
    () => fs.fchmodSync(3.5, 0o644),
    () => fs.readFileSync(3.5),
    () => fs.writeFileSync(3.5, "x"),
  ]) {
    assert.throws(fn, { code: "ERR_OUT_OF_RANGE" });
  }
  assert.throws(() => fs.fchownSync(50000, 0, 0), { code: "EBADF", syscall: "fchown" });
  assert.throws(() => fs.fchmodSync(50000, 0o644), { code: "EBADF", syscall: "fchmod" });
  const afterBadClose = join(root, "after-bad-close.txt");
  fs.writeFileSync(afterBadClose, "alive");
  assert.equal(fs.readFileSync(afterBadClose, "utf8"), "alive");

  // readFileSync honors flags and write-only EBADF has no path.
  for (const flag of ["a+", "as+", "w+", "wx+"]) {
    const file = join(root, `${flag.replace("+", "_plus")}.txt`);
    assert.equal(fs.readFileSync(file, { encoding: "utf8", flag }), "");
    assert.equal(fs.readFileSync(file, "utf8"), "");
  }
  assert.throws(
    () => fs.readFileSync(join(root, "w_only.txt"), { encoding: "utf8", flag: "w" }),
    (err: NodeJS.ErrnoException) => err.code === "EBADF" && err.path === undefined,
  );

  // copyFileSync on the same file preserves contents; COPYFILE_EXCL still fails with EEXIST.
  fs.copyFileSync(syncPath, syncPath);
  assert.equal(fs.readFileSync(syncPath, "utf8"), "ok");
  await fs.promises.copyFile(syncPath, syncPath);
  assert.equal(fs.readFileSync(syncPath, "utf8"), "ok");
  assert.throws(() => fs.copyFileSync(syncPath, syncPath, fs.constants.COPYFILE_EXCL), { code: "EEXIST" });
  assert.equal(fs.readFileSync(syncPath, "utf8"), "ok");

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
