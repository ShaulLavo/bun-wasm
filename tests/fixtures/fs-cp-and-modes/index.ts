import * as fs from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";

const root = "fs-cp-and-modes-work";
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root);

try {
  // 1. mkdirSync honors sticky bit (0o1000), ignores setuid/setgid (0o6000) like Linux/Bun, and masks by umask.
  const stickyDir = join(root, "sticky");
  fs.mkdirSync(stickyDir, { mode: 0o1777 });
  const stickyMode = fs.statSync(stickyDir).mode;
  assert.equal(stickyMode & 0o777, 0o777 & ~process.umask());
  assert.equal(stickyMode & 0o7000, 0o1000);

  const suidDir = join(root, "suid");
  fs.mkdirSync(suidDir, { mode: 0o4777 });
  const suidMode = fs.statSync(suidDir).mode;
  assert.equal(suidMode & 0o777, 0o777 & ~process.umask());
  assert.equal(suidMode & 0o7000, 0);

  // 2. mkdtempSync reports mode 0o700.
  const tmpDir = fs.mkdtempSync(join(root, "tmp-"));
  assert.equal(fs.statSync(tmpDir).mode & 0o777, 0o700);

  // 3. chmodSync and fchmodSync apply numeric and octal string modes above 0o777 and validate bad fds.
  const chmodDir = join(root, "chmod-dir");
  fs.mkdirSync(chmodDir);
  fs.chmodSync(chmodDir, 0o1777);
  assert.equal(fs.statSync(chmodDir).mode & 0o7777, 0o1777);
  fs.chmodSync(chmodDir, "1755");
  assert.equal(fs.statSync(chmodDir).mode & 0o7777, 0o1755);

  const fchmodFile = join(root, "fchmod-file");
  fs.writeFileSync(fchmodFile, "x");
  const fd = fs.openSync(fchmodFile, "r+");
  try {
    fs.fchmodSync(fd, 0o640);
    assert.equal(fs.fstatSync(fd).mode & 0o777, 0o640);
  } finally {
    fs.closeSync(fd);
  }
  assert.throws(() => fs.fchmodSync(fd, 0o600), { code: "EBADF", syscall: "fchmod" });

  // 4. Failed removals preserve recorded modes.
  const guardedDir = join(root, "guarded-dir");
  fs.mkdirSync(guardedDir);
  fs.writeFileSync(join(guardedDir, "keep.txt"), "keep");
  fs.chmodSync(guardedDir, 0o700);
  assert.throws(() => fs.rmSync(guardedDir));
  assert.equal(fs.statSync(guardedDir).mode & 0o777, 0o700);
  assert.throws(() => fs.rmdirSync(guardedDir));
  assert.equal(fs.statSync(guardedDir).mode & 0o777, 0o700);
  assert.throws(() => fs.unlinkSync(guardedDir));
  assert.equal(fs.statSync(guardedDir).mode & 0o777, 0o700);
  await assert.rejects(fs.promises.rm(guardedDir));
  assert.equal(fs.statSync(guardedDir).mode & 0o777, 0o700);

  // 5. Removing one hard link preserves the inode's mode on the remaining link.
  const linkA = join(root, "hard-a");
  const linkB = join(root, "hard-b");
  const linkC = join(root, "hard-c");
  fs.writeFileSync(linkA, "shared");
  fs.chmodSync(linkA, 0o600);
  fs.linkSync(linkA, linkB);
  fs.unlinkSync(linkB);
  assert.equal(fs.statSync(linkA).mode & 0o777, 0o600);
  fs.linkSync(linkA, linkC);
  fs.rmSync(linkC);
  assert.equal(fs.statSync(linkA).mode & 0o777, 0o600);

  // 6. cpSync / promises.cp error paths and conflict checks.
  const srcFile = join(root, "src.txt");
  const dstFile = join(root, "dst.txt");
  fs.writeFileSync(srcFile, "src");
  fs.writeFileSync(dstFile, "dst");
  assert.throws(
    () => fs.cpSync(srcFile, dstFile, { force: false, errorOnExist: true }),
    (err: NodeJS.ErrnoException) => err.code === "ERR_FS_CP_EEXIST" && err.path === dstFile,
  );
  await assert.rejects(
    fs.promises.cp(srcFile, dstFile, { force: false, errorOnExist: true }),
    (err: NodeJS.ErrnoException) => err.code === "ERR_FS_CP_EEXIST" && err.path === dstFile,
  );

  const srcDir = join(root, "src-dir");
  const dstDir = join(root, "dst-dir");
  fs.mkdirSync(join(srcDir, "d"), { recursive: true });
  fs.writeFileSync(join(srcDir, "d", "f.txt"), "hello");
  fs.chmodSync(join(srcDir, "d", "f.txt"), 0o600);
  fs.chmodSync(join(srcDir, "d"), 0o555);

  try {
    assert.throws(
      () => fs.cpSync(srcDir, dstDir),
      (err: NodeJS.ErrnoException) => err.code === "ERR_FS_EISDIR" && err.path === srcDir,
    );

    // Copying file onto existing directory rejects with ERR_FS_CP_NON_DIR_TO_DIR even with force: true.
    const conflictDst = join(root, "conflict-dst");
    fs.mkdirSync(join(conflictDst, "d", "f.txt"), { recursive: true });
    assert.throws(
      () => fs.cpSync(srcDir, conflictDst, { recursive: true }),
      { code: "ERR_FS_CP_NON_DIR_TO_DIR" },
    );
    await assert.rejects(
      fs.promises.cp(srcDir, conflictDst, { recursive: true }),
      { code: "ERR_FS_CP_NON_DIR_TO_DIR" },
    );

    // Copying directory onto existing file rejects with ERR_FS_CP_DIR_TO_NON_DIR (recursive and non-recursive).
    assert.throws(
      () => fs.cpSync(srcDir, dstFile, { recursive: true }),
      (err: NodeJS.ErrnoException) => err.code === "ERR_FS_CP_DIR_TO_NON_DIR" && err.path === dstFile,
    );
    assert.throws(
      () => fs.cpSync(srcDir, dstFile),
      (err: NodeJS.ErrnoException) => err.code === "ERR_FS_CP_DIR_TO_NON_DIR" && err.path === dstFile,
    );

    // Copying directory onto existing directory with force: false, errorOnExist: true rejects with ERR_FS_CP_EEXIST.
    const existingDir = join(root, "existing-dir");
    fs.mkdirSync(existingDir);
    fs.chmodSync(existingDir, 0o700);
    assert.throws(
      () => fs.cpSync(srcDir, existingDir, { recursive: true, force: false, errorOnExist: true }),
      (err: NodeJS.ErrnoException) => err.code === "ERR_FS_CP_EEXIST" && err.path === existingDir,
    );
    // Merging into an existing directory keeps the existing directory's mode.
    fs.cpSync(join(srcDir, "d"), existingDir, { recursive: true });
    assert.equal(fs.statSync(existingDir).mode & 0o777, 0o700);

    // 7. Recursive copy preserves file and read-only directory modes into a fresh destination.
    const preservedSync = join(root, "preserved-sync");
    fs.cpSync(srcDir, preservedSync, { recursive: true });
    assert.equal(fs.statSync(join(preservedSync, "d")).mode & 0o777, 0o555);
    assert.equal(fs.statSync(join(preservedSync, "d", "f.txt")).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(join(preservedSync, "d", "f.txt"), "utf8"), "hello");
    fs.chmodSync(join(preservedSync, "d"), 0o755);

    const preservedAsync = join(root, "preserved-async");
    await fs.promises.cp(srcDir, preservedAsync, { recursive: true });
    assert.equal(fs.statSync(join(preservedAsync, "d")).mode & 0o777, 0o555);
    assert.equal(fs.statSync(join(preservedAsync, "d", "f.txt")).mode & 0o777, 0o600);
    fs.chmodSync(join(preservedAsync, "d"), 0o755);
  } finally {
    fs.chmodSync(join(srcDir, "d"), 0o755);
  }

  // 8. Default, verbatim, and dereference symlink copies.
  const linkBase = join(root, "links");
  fs.mkdirSync(linkBase);
  fs.writeFileSync(join(linkBase, "target.txt"), "linked");
  fs.symlinkSync("target.txt", join(linkBase, "rel-link"));
  fs.cpSync(join(linkBase, "rel-link"), join(linkBase, "default-copy"));
  assert.equal(fs.lstatSync(join(linkBase, "default-copy")).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(join(linkBase, "default-copy"), "utf8"), "linked");
  fs.cpSync(join(linkBase, "rel-link"), join(linkBase, "verbatim-copy"), { verbatimSymlinks: true });
  assert.equal(fs.lstatSync(join(linkBase, "verbatim-copy")).isSymbolicLink(), true);
  assert.equal(fs.readlinkSync(join(linkBase, "verbatim-copy")), "target.txt");
  fs.cpSync(join(linkBase, "rel-link"), join(linkBase, "deref-copy"), { dereference: true });
  assert.equal(fs.lstatSync(join(linkBase, "deref-copy")).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(join(linkBase, "deref-copy"), "utf8"), "linked");

  console.log("fs cp and modes ok");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
