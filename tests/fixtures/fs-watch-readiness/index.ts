import assert from "node:assert/strict";
import fs from "node:fs";

const path = "watch-readiness.txt";
fs.writeFileSync(path, "before");
let watcher: fs.FSWatcher | undefined;
try {
  if (process.env.BUNWASM_TEST_HOST === "node") {
    assert.throws(() => fs.watch(path), { code: "ENOTSUP" });
  } else {
    const changed = new Promise<void>((resolve, reject) => {
      watcher = fs.watch(path, () => resolve());
      watcher.once("error", reject);
    });
    setTimeout(() => fs.writeFileSync(path, "after"), 0);
    await changed;
    assert.equal(fs.readFileSync(path, "utf8"), "after");
  }
  console.log("filesystem readiness preserves the host's watcher behavior");
} finally {
  watcher?.close();
  fs.unlinkSync(path);
}
