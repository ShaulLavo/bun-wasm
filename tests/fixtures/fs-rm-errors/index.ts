import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join } from "node:path";

function removeWithCallback(path: string, options: fs.RmOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    fs.rm(path, options, error => error ? reject(error) : resolve());
  });
}

async function checkErrors(root: string) {
  fs.symlinkSync("cycle", join(root, "cycle"));
  const loop = join(root, "cycle/entry");
  const missing = join(root, "missing");
  for (const force of [false, true]) {
    const options = { force };
    assert.throws(() => fs.rmSync(loop, options), { code: "ELOOP" });
    await assert.rejects(removeWithCallback(loop, options), { code: "ELOOP" });
    await assert.rejects(fs.promises.rm(loop, options), { code: "ELOOP" });
  }
  assert.throws(() => fs.rmSync(missing), { code: "ENOENT" });
  await assert.rejects(removeWithCallback(missing, {}), { code: "ENOENT" });
  await assert.rejects(fs.promises.rm(missing), { code: "ENOENT" });
  fs.rmSync(missing, { force: true });
  await removeWithCallback(missing, { force: true });
  await fs.promises.rm(missing, { force: true });
}

function checkRemovals(root: string) {
  const file = join(root, "file");
  fs.writeFileSync(file, "remove");
  fs.rmSync(file);
  assert.equal(fs.existsSync(file), false);
  const directory = join(root, "directory");
  const child = join(directory, "child");
  fs.mkdirSync(directory);
  fs.writeFileSync(child, "keep until recursive");
  assert.throws(() => fs.rmSync(directory, { force: true }), { code: "ERR_FS_EISDIR" });
  assert.equal(fs.readFileSync(child, "utf8"), "keep until recursive");
  fs.rmSync(directory, { recursive: true, force: true });
  assert.equal(fs.existsSync(directory), false);

  const trailingDir = join(root, "trailing-directory");
  fs.mkdirSync(trailingDir);
  fs.writeFileSync(join(trailingDir, "child"), "remove with slash");
  fs.rmSync(`${trailingDir}/`, { recursive: true, force: true });
  assert.equal(fs.existsSync(trailingDir), false);
}

async function checkFinalSymlinks(root: string) {
  const referent = join(root, "referent");
  fs.mkdirSync(referent);
  fs.writeFileSync(join(referent, "child"), "keep");
  const link = join(root, "link");
  for (const recursive of [false, true]) {
    fs.symlinkSync("referent", link);
    fs.rmSync(link, { recursive, force: true });
    assert.throws(() => fs.lstatSync(link), { code: "ENOENT" });
    assert.equal(fs.readFileSync(join(referent, "child"), "utf8"), "keep");
  }

  // Trailing slash on symlinks (live or dangling) rejects without deleting link or referent.
  fs.symlinkSync("referent", link);
  const linkSlash = `${link}/`;
  for (const options of [{ recursive: true }, { recursive: true, force: true }]) {
    assert.throws(() => fs.rmSync(linkSlash, options), { code: "ENOTDIR" });
    await assert.rejects(removeWithCallback(linkSlash, options), { code: "ENOTDIR" });
    await assert.rejects(fs.promises.rm(linkSlash, options), { code: "ENOTDIR" });
  }
  assert.throws(() => fs.rmSync(linkSlash, { force: true }), { code: "ERR_FS_EISDIR" });
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(join(referent, "child"), "utf8"), "keep");

  const dangling = join(root, "dangling");
  fs.symlinkSync("does-not-exist", dangling);
  for (const options of [{ recursive: true }, { recursive: true, force: true }]) {
    assert.throws(() => fs.rmSync(`${dangling}/`, options), { code: "ENOTDIR" });
  }
  assert.throws(() => fs.rmSync(`${dangling}/`, { force: true }));
  assert.equal(fs.lstatSync(dangling).isSymbolicLink(), true);

  // rmdir trailing slashes, symlinks, and recursive file removal match Bun.
  assert.throws(() => fs.rmdirSync(linkSlash, { recursive: true }), { code: "ENOTDIR" });
  assert.throws(() => fs.rmdirSync(linkSlash), { code: "ENOTDIR" });
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(join(referent, "child"), "utf8"), "keep");

  const empty = join(root, "empty-rmdir");
  fs.mkdirSync(empty);
  fs.rmdirSync(`${empty}/`);
  assert.equal(fs.existsSync(empty), false);

  const nonempty = join(root, "nonempty-rmdir");
  fs.mkdirSync(nonempty);
  fs.writeFileSync(join(nonempty, "a"), "a");
  assert.throws(() => fs.rmdirSync(`${nonempty}/`), { code: "ENOTEMPTY" });
  fs.rmdirSync(`${nonempty}/`, { recursive: true });
  assert.equal(fs.existsSync(nonempty), false);

  const plainFile = join(root, "rmdir-file");
  fs.writeFileSync(plainFile, "bye");
  fs.rmdirSync(plainFile, { recursive: true });
  assert.equal(fs.existsSync(plainFile), false);
}

const root = fs.mkdtempSync("fs-rm-errors-");
try {
  await checkErrors(root);
  checkRemovals(root);
  await checkFinalSymlinks(root);
  console.log("filesystem removal errors ok");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
