import assert from "node:assert/strict";
import fs from "node:fs";

type Change = [fs.Stats, fs.Stats];
const options = { interval: 20 };

function nextChange(watcher: fs.StatWatcher): Promise<Change> {
  return new Promise(resolve => watcher.once("change", (current: fs.Stats, previous: fs.Stats) => resolve([current, previous])));
}

function describe([current, previous]: Change): string {
  return `current size ${current.size} file ${current.isFile()} mtimeMs ${current.mtimeMs === 0 ? 0 : "set"}; previous size ${previous.size} file ${previous.isFile()} mtimeMs ${previous.mtimeMs === 0 ? 0 : "set"}`;
}

assert.throws(() => Reflect.apply(fs.watchFile, fs, ["watched.txt"]), { code: "ERR_INVALID_ARG_TYPE" });
console.log("a missing listener is rejected");

const first = () => {};
const watcher = fs.watchFile("watched.txt", options, first);
const initial = nextChange(watcher);
const shared = fs.watchFile("watched.txt", options, () => {});
console.log("one watcher per path:", watcher === shared, watcher.listenerCount("change"));
console.log("missing at start:", describe(await initial));

const created = nextChange(watcher);
fs.writeFileSync("watched.txt", "hello");
console.log("created:", describe(await created));

const changed = nextChange(watcher);
fs.writeFileSync("watched.txt", "hello world");
console.log("changed:", describe(await changed));

const removed = nextChange(watcher);
fs.unlinkSync("watched.txt");
console.log("removed:", describe(await removed));

fs.unwatchFile("watched.txt", first);
console.log("one listener removed:", watcher.listenerCount("change"));
const stopped = new Promise<void>(resolve => watcher.once("stop", resolve));
fs.unwatchFile("watched.txt");
await stopped;
console.log("stopped:", watcher.listenerCount("change"));
fs.unwatchFile("never-watched.txt");

fs.watchFile("idle.txt", { persistent: false, interval: 20 }, () => {});
console.log("a non-persistent watcher lets the process exit");
