// process._rawDebug writes straight to fd 2 and never throws; once the program closed fd 2 the
// write goes nowhere, and nothing reaches the real stderr (the fixture expects it empty).
import { closeSync } from "node:fs";

closeSync(2);
process._rawDebug("marker", { a: 1 });
console.log("ok");
