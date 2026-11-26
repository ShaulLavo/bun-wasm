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

fs.writeFileSync("long.txt", "before");
let longPolled = false;
fs.watchFile("long.txt", { interval: 2 ** 31 }, () => { longPolled = true; });
fs.writeFileSync("long.txt", "after, longer");

const nested = fs.watchFile("parent/child.txt", options, () => {});
await nextChange(nested);
const appeared = nextChange(nested);
fs.mkdirSync("parent");
fs.writeFileSync("parent/child.txt", "hello");
console.log("nested file appeared:", describe(await appeared));
const replaced = nextChange(nested);
fs.rmSync("parent", { recursive: true });
fs.writeFileSync("parent", "now a file");
console.log("parent replaced by a file:", describe(await replaced));
fs.unwatchFile("parent/child.txt");
const underFile = nextChange(fs.watchFile("parent/child.txt", options, () => {}));
console.log("watching below a file starts missing:", describe(await underFile));
fs.unwatchFile("parent/child.txt");

console.log("an interval above 2^31 - 1 ms has not polled:", !longPolled);
fs.unwatchFile("long.txt");

let thrown = 0;
const caught = new Promise<void>(resolve => process.once("uncaughtException", () => { thrown++; resolve(); }));
const throwing = fs.watchFile("throws.txt", options, (current: fs.Stats) => {
  if (current.size > 0 && thrown === 0) throw new Error("listener failed");
});
await nextChange(throwing);
fs.writeFileSync("throws.txt", "ab");
await caught;
const afterThrow = nextChange(throwing);
fs.writeFileSync("throws.txt", "abc");
console.log("a listener that threw does not stop polling:", describe(await afterThrow));
fs.unwatchFile("throws.txt");

let restartedOnce = false;
let callsAfterRestart = 0;
const restartCaught = new Promise<void>(resolve => process.once("uncaughtException", () => resolve()));
const restarted: fs.StatWatcher = fs.watchFile("restart.txt", options, (current: fs.Stats) => {
  if (restartedOnce) {
    callsAfterRestart++;
    return;
  }
  if (current.size === 0) return;
  restartedOnce = true;
  restarted.stop();
  restarted.start();
  throw new Error("listener failed after stop and start");
});
await nextChange(restarted);
fs.writeFileSync("restart.txt", "a");
await restartCaught;
fs.writeFileSync("restart.txt", "abc");
const pacer = fs.watchFile("pacer.txt", options, () => {});
await nextChange(pacer);
const paced = nextChange(pacer);
fs.writeFileSync("pacer.txt", "x");
await paced;
fs.unwatchFile("pacer.txt");
fs.unwatchFile("restart.txt");
console.log("listener calls after stop(), start() and a throw:", callsAfterRestart);

fs.watchFile("idle.txt", { persistent: false, interval: 20 }, () => {});
console.log("a non-persistent watcher lets the process exit");
