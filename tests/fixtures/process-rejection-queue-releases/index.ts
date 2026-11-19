// The rejection queue keeps a promise alive exactly as long as it can still be reported
// (upstream process.test.js "reports exactly the rejections that stay unhandled"). Counts live
// Dates with bun:jsc heapStats, which only the JSC engine can give.
import { heapStats } from "bun:jsc";

const noop = () => {};
const drain = async () => { for (let i = 0; i < 3; i++) await new Promise(r => setImmediate(r)); };
// Nothing else in this script makes a Date, so this counts the rejection reasons that are alive.
const datesAlive = () => (Bun.gc(true), heapStats().objectTypeCounts.Date ?? 0);
let seen = 0;
process.on("unhandledRejection", () => seen++);

// Every 7th promise stays unhandled; the others are handled one step late.
let previous: Promise<unknown> | undefined;
for (let i = 0; i < 1000; i++) {
  const promise = Promise.reject(i % 7 === 0 ? new Date(i) : i);
  if (i % 7 === 0) continue;
  previous?.catch(noop);
  previous = promise;
}
previous!.catch(noop);
// The promises that stay unhandled, and their reasons, are reachable only through the queue now.
console.log("queued alive", datesAlive());
await drain();
console.log("reported", seen);

// In a loop that awaits, each handled promise is garbage at once: the queue must not keep
// them until the end of the turn.
const before = datesAlive();
let mostAlive = 0;
previous = Promise.reject(new Date(0));
for (let i = 1; i <= 2000; i++) {
  const promise = Promise.reject(new Date(i));
  try { await previous; } catch {}
  previous = promise;
  if (i % 500 === 0) mostAlive = Math.max(mostAlive, datesAlive() - before);
}
try { await previous; } catch {}
console.log("handled are released", mostAlive < 200 ? true : mostAlive);
