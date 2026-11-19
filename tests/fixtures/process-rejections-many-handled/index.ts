// Many rejections handled while they wait to be reported (in no particular order), and while
// they are being reported (from the first 'unhandledRejection' listener call): only the events
// upstream process.test.js "handling N rejected promises is O(N)" expects.
const N = 20_000;
const noop = () => {};
const drain = async () => { for (let i = 0; i < 3; i++) await new Promise(r => setImmediate(r)); };
const events = { unhandledRejection: 0, rejectionHandled: 0 };
let onUnhandled = noop;
process.on("unhandledRejection", () => {
  events.unhandledRejection++;
  onUnhandled();
});
process.on("rejectionHandled", () => events.rejectionHandled++);

// 7919 is coprime to N: every promise once, none next to the one before.
let promises: Promise<unknown>[] = [];
for (let i = 0; i < N; i++) promises.push(Promise.reject(i));
for (let i = 0; i < N; i++) promises[(i * 7919) % N].catch(noop);
await drain();
console.log("while waiting", JSON.stringify(events));

// The first report handles the other N - 1, newest first.
promises = [];
onUnhandled = () => {
  onUnhandled = noop;
  for (let i = N - 1; i > 0; i--) promises[i].catch(noop);
};
for (let i = 0; i < N; i++) promises.push(Promise.reject(i));
await drain();
console.log("while reporting", JSON.stringify(events));
