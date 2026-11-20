// process.env.TZ sets the zone of local time and Intl on the main thread, as in Node and Bun:
// on every write, through defineProperty, and back to the start zone on delete. A write in a
// worker or on an object that inherits from process.env changes nothing.
const { Worker } = require("node:worker_threads");
const date = new Date("2024-01-15T12:00:00Z");
const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const start = [date.getHours(), zone()];

process.env.TZ = "America/New_York";
console.log("assigned", date.getHours(), zone());
delete process.env.TZ;
console.log("deleted restores the start zone", date.getHours() === start[0], zone() === start[1], "TZ" in process.env);
process.env.TZ = "Asia/Tokyo";
console.log("assigned after delete", date.getHours(), zone());
Object.defineProperty(process.env, "TZ", { value: "America/New_York", writable: true, enumerable: true, configurable: true });
console.log("defined", date.getHours(), zone());
process.env.TZ = "UTC";
console.log("assigned after define", date.getHours());

const child = Object.create(process.env);
child.TZ = "Asia/Kolkata";
console.log("inherited write", date.getHours(), process.env.TZ, child.TZ);

process.env.TZ = "America/New_York";
const worker = new Worker(`
  process.env.TZ = "Asia/Tokyo";
  delete process.env.TZ;
  process.env.TZ = "Europe/London";
  require("node:worker_threads").parentPort.postMessage(0);
`, { eval: true });
worker.once("message", () => {
  console.log("after worker writes", date.getHours(), zone());
  worker.terminate();
});
