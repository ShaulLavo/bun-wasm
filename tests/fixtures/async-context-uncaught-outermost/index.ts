// When callbacks nest, an 'uncaughtException' handler reads the store of the outermost callback
// the error escaped, as in Bun: every inner one has unwound by then. An error caught in one
// callback and rethrown from another reads the second one's store, primitives included.
import { AsyncLocalStorage, AsyncResource } from "node:async_hooks";

const als = new AsyncLocalStorage<string>();
const seen: string[] = [];
process.on("uncaughtException", error => {
  seen.push(`${error instanceof Error ? error.message : String(error)} -> ${als.getStore() ?? "no store"}`);
});
process.on("exit", () => console.log(seen.join("\n")));

// An AsyncResource.bind callback bound in "bound", called from a timer started in "timer".
const bound = als.run("bound", () => AsyncResource.bind(() => { throw new Error("a bound callback called from a timer"); }));
als.run("timer", () => setTimeout(() => bound(), 1));

// A snapshot() taken in "snapshot", run from a timer started in "timer 2".
const snapshot = als.run("snapshot", () => AsyncLocalStorage.snapshot());
als.run("timer 2", () => setTimeout(() => snapshot(() => { throw new Error("a snapshot run from a timer"); }), 10));

// A stream's pull throws in "caught"; a timer started in "rethrow" throws the same error later.
let saved: unknown;
const failing = als.run("caught", () => new ReadableStream({ pull() { throw new Error("an error caught in one callback and rethrown from another"); } }));
failing.getReader().read().catch(error => { saved = error; });
als.run("rethrow", () => setTimeout(() => { throw saved; }, 20));

// A primitive escapes a callback bound in "primitive" and is caught, then a timer with no store
// throws the same primitive.
const throwsPrimitive = als.run("primitive", () => AsyncLocalStorage.bind(() => { throw "a primitive"; }));
try { throwsPrimitive(); } catch {}
setTimeout(() => { throw "a primitive"; }, 30);
