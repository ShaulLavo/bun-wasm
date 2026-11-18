// stream.duplexPair and bun:internal-for-testing's exposedInternals, as upstream
// test/js/node/stream/node-stream.test.js imports them.
import { exposedInternals } from "bun:internal-for-testing";
import stream, { Duplex, duplexPair } from "node:stream";
import { once } from "node:events";

console.log("exported", typeof duplexPair, stream.duplexPair === duplexPair);

const [left, right] = duplexPair();
console.log("sides are Duplex", left instanceof Duplex, right instanceof Duplex);
const received: string[] = [];
right.on("data", chunk => received.push(String(chunk)));
const ended = once(right, "end");
left.write("hello ");
left.write("");
left.end("pair");
await ended;
console.log("right read", JSON.stringify(received.join("")));

const [reply, ask] = duplexPair({ encoding: "utf8" });
ask.write("ping");
const [answer] = await once(reply, "data");
console.log("encoded chunk", typeof answer, answer);

// Destroying one side with an error closes the peer without re-emitting the error.
const [a, b] = duplexPair();
const errors: string[] = [];
a.on("error", error => errors.push(`a: ${(error as Error).message}`));
b.on("error", error => errors.push(`b: ${(error as Error).message}`));
const bClosed = once(b, "close");
a.resume();
b.resume();
a.destroy(new Error("boom"));
await bClosed;
console.log("error teardown", a.destroyed, b.destroyed, JSON.stringify(errors));

// Destroying one side without an error ends the peer's readable side.
const [c, d] = duplexPair();
const dEnded = once(d, "end");
d.resume();
c.destroy();
await dEnded;
console.log("plain teardown", c.destroyed);

const FixedQueue = exposedInternals["internal/fixed_queue"];
const queue = new FixedQueue();
const list = queue.head.list;
let holes = 0;
for (let i = 0; i < list.length; i++) if (!(i in list)) holes++;
for (let i = 0; i < 3000; i++) queue.push(i);
let sum = 0;
while (!queue.isEmpty()) sum += queue.shift();
console.log("FixedQueue", typeof FixedQueue, list.length, holes, sum);
console.log("FreeList", typeof exposedInternals["internal/freelist"]);
