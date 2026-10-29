import { answer, events } from "./awaited.mts";
import * as sync from "./sync.mts";
console.log("imported TLA", answer, events.join(","));
sync.increment();
console.log("live", sync.count, (await import("./sync.mts")) === sync);
let first: unknown;
try { await import("./rejected.mts"); } catch (error) { first = error; }
try { await import("./rejected.mts"); } catch (error) { console.log("rejection identity", first === error); }
console.log("metadata", import.meta.url.endsWith("/main.mts"),
  import.meta.resolve("./sync.mts").endsWith("/sync.mts"), import.meta === import.meta);
