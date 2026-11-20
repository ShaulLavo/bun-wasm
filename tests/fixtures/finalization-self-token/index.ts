// Runtime wrappers (zlib streams, TextDecoder, SQLite statements, streams) register
// themselves with `registry.register(obj, handle, obj)` so close() can unregister.
// The spec holds the unregister token weakly; a strong token never let the object die.
const count = 10_000;
const kinds = ["self", "separate", "symbol"] as const;
type Kind = (typeof kinds)[number];
const finalized = new Map<Kind, Set<number>>(kinds.map(kind => [kind, new Set()]));
let callbacks = 0;
const registry = new FinalizationRegistry(([kind, index]: [Kind, number]) => {
  callbacks++;
  finalized.get(kind)!.add(index);
});

function registerDropped(): void {
  for (let i = 0; i < count; i++) {
    const self = { payload: new Array(8).fill(i) };
    registry.register(self, ["self", i], self);
    const separate = { payload: new Array(8).fill(i) };
    registry.register(separate, ["separate", i], {});
    const symbol = { payload: new Array(8).fill(i) };
    registry.register(symbol, ["symbol", i], Symbol("token"));
  }
}

registerDropped();
for (let round = 0; round < 50 && callbacks < kinds.length * count; round++) {
  Bun.gc(true);
  await new Promise(resolve => setTimeout(resolve, 0));
}
for (let round = 0; round < 3; round++) {
  Bun.gc(true);
  await new Promise(resolve => setTimeout(resolve, 0));
}
// A conservative stack scan may keep the last few objects of a loop alive.
const nearlyAll = count - 10;
for (const kind of kinds) console.log(`${kind} token finalized:`, finalized.get(kind)!.size >= nearlyAll);
const distinct = kinds.reduce((total, kind) => total + finalized.get(kind)!.size, 0);
console.log("each cleanup ran once:", callbacks === distinct);

const checks = new FinalizationRegistry(() => {});
const live = {};
checks.register(live, "live", live);
console.log("unregister a live self token:", checks.unregister(live), checks.unregister(live));
const shared = {};
const kept = [{}, {}, {}];
for (const target of kept) checks.register(target, "shared", shared);
console.log("unregister a token used three times:", checks.unregister(shared), checks.unregister(shared));

const invalid: unknown[] = [1, "token", null, undefined, Symbol.for("registered")];
const describe = (run: () => unknown): string => {
  try {
    run();
    return "accepted";
  } catch (error) {
    return error instanceof TypeError ? "TypeError" : String(error);
  }
};
console.log("unregister invalid tokens:", invalid.map(token => describe(() => checks.unregister(token as object))).join(" "));
console.log(
  "register invalid tokens:",
  invalid.map(token => describe(() => checks.register({}, "bad", token as object))).join(" "),
  kept.length,
);
