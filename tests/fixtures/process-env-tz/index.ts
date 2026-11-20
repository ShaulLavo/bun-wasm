// process.env.TZ sets the zone of local time and Intl on the main thread, as in Node and Bun:
// on every write, through defineProperty, and back to the start zone on delete. Intl takes the
// zone ID ICU resolved (GMT and Etc/UTC are UTC, EST5EDT is America/New_York) and never throws
// for a zone name. A write in a worker or on an object that inherits from process.env changes
// nothing, and a worker started after a TZ write uses that zone for Date and Intl alike.
const { Worker } = require("node:worker_threads");
const date = new Date("2024-01-15T12:00:00Z");
const summer = new Date("2024-07-15T12:00:00Z");
const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const hour = (value: Date) => new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23" }).format(value);
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

for (const name of ["GMT", "Etc/UTC", "Etc/GMT", "EST5EDT"]) {
  process.env.TZ = name;
  console.log("alias", name, zone(), summer.getHours(), hour(summer), new Intl.NumberFormat("en-US").format(1234.5));
}
process.env.TZ = "Asia/Tokyo";
process.env.TZ = "Not/AZone";
console.log("unknown zone keeps the previous one", summer.getHours(), zone(), hour(summer));

const child = Object.create(process.env);
child.TZ = "Asia/Kolkata";
console.log("inherited write", summer.getHours(), process.env.TZ, child.TZ);

function inWorker(source: string) {
  return new Promise(resolve => {
    const worker = new Worker(source, { eval: true });
    worker.once("message", message => {
      worker.terminate();
      resolve(message);
    });
  });
}
const report = `
  const summer = new Date("2024-07-15T12:00:00Z");
  require("node:worker_threads").parentPort.postMessage([process.env.TZ, summer.getHours(),
    Intl.DateTimeFormat().resolvedOptions().timeZone, new Intl.NumberFormat("en-US").format(1234.5)]);
`;

process.env.TZ = "America/New_York";
inWorker(`
  process.env.TZ = "Asia/Tokyo";
  delete process.env.TZ;
  process.env.TZ = "Europe/London";
  require("node:worker_threads").parentPort.postMessage(0);
`).then(() => {
  console.log("after worker writes", summer.getHours(), zone());
  process.env.TZ = "Asia/Tokyo";
  return inWorker(report);
}).then(message => {
  console.log("worker started in Asia/Tokyo", JSON.stringify(message));
  process.env.TZ = "GMT";
  return inWorker(report);
}).then(message => {
  console.log("worker started in GMT", JSON.stringify(message));
});
