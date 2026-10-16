const fs = require("node:fs");
const assert = require("node:assert/strict");
fs.mkdirSync("buffer-tree");
fs.writeFileSync("buffer-tree/naïve", "x");
function check(directory, input) {
  assert(Buffer.isBuffer(directory.path));
  assert.equal(directory.path, input);
  const entry = directory.readSync();
  assert(Buffer.isBuffer(entry.name));
  assert(Buffer.isBuffer(entry.parentPath));
  assert.equal(entry.parentPath, input);
  directory.closeSync();
}
async function main() {
  const input = Buffer.from("buffer-tree");
  check(fs.opendirSync(input, { encoding: "buffer" }), input);
  await new Promise((resolve, reject) => fs.opendir(input, { encoding: "buffer" }, (error, directory) => {
    if (error) return reject(error);
    try { check(directory, input); resolve(); } catch (failure) { reject(failure); }
  }));
  check(await fs.promises.opendir(input, { encoding: "buffer" }), input);
  for (const encoding of ["", false, 0]) {
    const directory = fs.opendirSync(input, { encoding });
    assert.equal(directory.readSync().name, "naïve");
    directory.closeSync();
  }
  console.log("sync, callback and promise paths keep Buffer identity; falsy encodings use utf8");
}
main();
