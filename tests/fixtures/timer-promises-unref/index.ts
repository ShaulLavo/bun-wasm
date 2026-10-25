import { setTimeout, setImmediate, setInterval } from "node:timers/promises";

void setTimeout(10000, "timeout", { ref: false }).then(() => console.log("unexpected timeout"));
void setImmediate("immediate", { ref: false });
void setInterval(10000, "interval", { ref: false }).next().then(() => console.log("unexpected interval"));
console.log("unreferenced promise timers do not keep the process alive");
