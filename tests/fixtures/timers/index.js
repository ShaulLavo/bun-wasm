const order = [];
const log = (s) => order.push(s);

setTimeout(() => log("timeout 50"), 50);
setTimeout(() => log("timeout 0"), 0);
setTimeout(() => log("timeout 30"), 30);
const cancelled = setTimeout(() => log("cancelled!"), 5);
clearTimeout(cancelled);
setImmediate(() => log("immediate"));
process.nextTick(() => log("nextTick"));
Promise.resolve().then(() => log("promise"));
queueMicrotask(() => log("microtask"));
log("sync");

let ticks = 0;
const iv = setInterval(() => {
  ticks++;
  log(`interval ${ticks}`);
  if (ticks === 3) clearInterval(iv);
}, 3);

setTimeout((a, b) => log(`args ${a} ${b}`), 1, "x", "y");

const unrefd = setTimeout(() => log("unref'd never runs"), 1000);
unrefd.unref();

const t = setTimeout(() => {}, 1);
console.log("timer object:", typeof t.ref, typeof t.unref, typeof t.hasRef, t.hasRef());

const start = performance.now();
Bun.sleep(55).then(() => {
  const elapsed = performance.now() - start;
  log(`Bun.sleep resolved after >=55ms: ${elapsed >= 54}`);
});

const ac = new AbortController();
ac.signal.addEventListener("abort", () => log(`abort: ${ac.signal.reason}`));
setTimeout(() => ac.abort("stop"), 40);

require("timers/promises")
  .setTimeout(45, "promised")
  .then((v) => log(`timers/promises: ${v}`));

setTimeout(() => {
  // Timers keep ordering relative to each other.
  console.log(order.join("\n"));
}, 80);
