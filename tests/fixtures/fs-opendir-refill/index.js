const fs = require("node:fs");
const assert = require("node:assert/strict");
fs.mkdirSync("refill-tree");
for (const name of ["one", "two", "three", "four"]) fs.writeFileSync("refill-tree/" + name, name);
async function refill(bufferSize) {
  const directory = fs.opendirSync("refill-tree", { bufferSize });
  await new Promise((resolve, reject) => directory.read((error, entry) => {
    if (error) return reject(error);
    try {
      assert(entry instanceof fs.Dirent);
      assert.throws(() => directory.readSync(), { code: "ERR_DIR_CONCURRENT_OPERATION" });
      assert.throws(() => directory.closeSync(), { code: "ERR_DIR_CONCURRENT_OPERATION" });
      resolve();
    } catch (failure) { reject(failure); }
  }));
  directory.closeSync();
}
async function main() {
  await refill(1);
  await refill(32);
  const buffered = fs.opendirSync("refill-tree");
  buffered.readSync();
  const result = buffered.read();
  assert(buffered.readSync() instanceof fs.Dirent);
  buffered.closeSync();
  assert(await result instanceof fs.Dirent);
  console.log("refill callbacks stay busy at sizes 1 and 32; buffered reads stay idle");
}
main();
