// Which rejections are reported, and when 'rejectionHandled' fires, whatever order the others
// are handled in (upstream process.test.js "reports exactly the rejections that stay
// unhandled", without its JSC heap counts).
const noop = () => {};
const drain = async () => { for (let i = 0; i < 3; i++) await new Promise(r => setImmediate(r)); };
let seen: unknown[] = [];
let rejectionHandled = 0;
let onUnhandled: (reason: unknown) => void = noop;
process.on("unhandledRejection", reason => {
  seen.push(reason);
  onUnhandled(reason);
});
const handledPromises: Promise<unknown>[] = [];
process.on("rejectionHandled", promise => {
  rejectionHandled++;
  handledPromises.push(promise);
});
const show = (name: string) => console.log(name, seen.length, seen.slice(0, 6).join(" "), "rejectionHandled", rejectionHandled);

// Every 7th promise stays unhandled; each of the others is handled one step late.
let previous: Promise<unknown> | undefined;
for (let i = 0; i < 1000; i++) {
  const promise = Promise.reject(i);
  if (i % 7 === 0) continue;
  previous?.catch(noop);
  previous = promise;
}
previous!.catch(noop);
await drain();
show("oneStepLate");
console.log("every 7th", seen.every((reason, i) => reason === i * 7));

// Handled oldest first, as Promise.all does. Every 50th stays unhandled.
seen = [];
const oldestFirst: Promise<unknown>[] = [];
for (let i = 0; i < 200; i++) oldestFirst.push(Promise.reject("o" + i));
for (let i = 0; i < 200; i++) if (i % 50 !== 49) oldestFirst[i].catch(noop);
await drain();
show("oldestFirst");

// Handled newest first. The oldest and one in the middle stay unhandled.
seen = [];
const newestFirst: Promise<unknown>[] = [];
for (let i = 0; i < 100; i++) newestFirst.push(Promise.reject("n" + i));
for (let i = 99; i > 0; i--) if (i !== 50) newestFirst[i].catch(noop);
await drain();
show("newestFirst");

// A few rejections, handled in no particular order.
seen = [];
const few: Promise<unknown>[] = [];
for (let i = 0; i < 8; i++) few.push(Promise.reject("f" + i));
for (const i of [3, 0, 7, 6, 4]) few[i].catch(noop);
await drain();
show("few");

// A long queue loses an entry in the middle and its newest entry, then grows again.
seen = [];
const regrown: Promise<unknown>[] = [];
for (let i = 0; i < 300; i++) regrown.push(Promise.reject("r" + i));
regrown[5].catch(noop);
Bun.gc(true);
regrown[299].catch(noop);
Promise.reject("older").catch(noop);
Promise.reject("newer").catch(noop);
await drain();
show("regrown");
console.log("regrown last", seen.at(-1), "has r5", seen.includes("r5"));

// The listener for the first rejection handles every odd one after it: neither event for them.
// b2 is handled after this batch reported it: one 'rejectionHandled'.
seen = [];
const batch: Promise<unknown>[] = [];
onUnhandled = reason => {
  if (reason === "b0") for (let i = 1; i < 600; i += 2) batch[i].catch(noop);
  if (reason === "b2") Bun.gc(true);
  if (reason === "b4") batch[2].catch(noop);
};
for (let i = 0; i < 600; i++) batch.push(Promise.reject("b" + i));
await drain();
show("handledByListener");
console.log("rejectionHandled gets the promise", handledPromises[0] === batch[2]);

// Handled after the report, while other rejections wait in the queue: one 'rejectionHandled'
// each (b2 already had its own).
seen = [];
onUnhandled = noop;
for (let i = 0; i < 300; i++) Promise.reject("q" + i);
for (let i = 0; i < 600; i += 2) batch[i].catch(noop);
await drain();
show("handledAfterReport");

// A second handler is not a first handler: no more events.
seen = [];
for (let i = 0; i < 600; i += 2) batch[i].catch(noop);
await drain();
show("handledAgain");
