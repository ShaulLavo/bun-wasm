import assert from "node:assert/strict";
import fs from "node:fs";

fs.writeFileSync("watch-options.txt", "before");
const invalidOptions = ["not-an-encoding", "buffer!", "utf9", 7, {}].flatMap<unknown>(encoding =>
  typeof encoding === "string" ? [encoding, { encoding }] : [{ encoding }]);
for (const value of invalidOptions) {
  let watcher: fs.FSWatcher | undefined;
  try {
    assert.throws(() => { watcher = Reflect.apply(fs.watch, fs, ["watch-options.txt", value]); }, { code: "ERR_INVALID_ARG_VALUE" });
  } finally { watcher?.close(); }
}
console.log("invalid filename encodings fail at watch registration");

for (const value of [undefined, null, "", { encoding: "" }, { encoding: null }, { encoding: undefined }, "utf8", "buffer", { encoding: "utf16le" }]) {
  const watcher: fs.FSWatcher = Reflect.apply(fs.watch, fs, ["watch-options.txt", value]);
  watcher.close();
}
console.log("default and supported filename encodings register and close");
