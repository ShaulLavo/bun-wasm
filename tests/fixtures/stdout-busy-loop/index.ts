// Prints one line, then keeps the event loop busy without ever idling until the host
// acknowledges that it read the line. A buffered stdout that is only flushed on idle deadlocks.
import { existsSync } from "node:fs";

const deadline = Date.now() + 20000;
console.log("ready");
function turn() {
  if (existsSync("/ack")) {
    console.log("acknowledged");
    return;
  }
  if (Date.now() > deadline) {
    console.error("stdout stayed buffered while the event loop was busy");
    process.exit(1);
  }
  setImmediate(turn);
}
setImmediate(turn);
