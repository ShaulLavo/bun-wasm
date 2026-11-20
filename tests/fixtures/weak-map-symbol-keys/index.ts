// A WeakMap entry lives while both its key and its map do; symbols are valid keys. Freeing a
// WeakMap or clearing a Map must also survive values that own the keys of later entries.
const count = 1000;

type Holder = { map: WeakMap<object | symbol, unknown> | null };

function fillChained(holder: Holder, keep: object, keepSymbol: object): void {
  // These locals die at return, so each key below is owned only by an earlier value.
  const object = {};
  const symbol = Symbol("next");
  holder.map!.set(keep, { object });
  holder.map!.set(object, { tag: 1 });
  holder.map!.set(keepSymbol, symbol);
  holder.map!.set(symbol, 1);
}

function freeChainedWeakMaps(): number {
  const keep = {};
  const keepSymbol = {};
  let freed = 0;
  for (let i = 0; i < count; i++) {
    const holder: Holder = { map: new WeakMap() };
    fillChained(holder, keep, keepSymbol);
    holder.map = null;
    freed++;
  }
  return freed;
}

function clearPinnedMaps(): boolean {
  let empty = true;
  for (let i = 0; i < count; i++) {
    const map = new Map<string, unknown>([["a", 0], ["b", 1], ["c", 2]]);
    let iterator: Iterator<unknown> | null = map.entries();
    iterator.next();
    iterator.next();
    map.delete("b");
    map.set("a", iterator);
    iterator = null;
    map.clear();
    empty &&= map.size === 0;
  }
  return empty;
}

const liveSymbol = Symbol("live");
const liveMap = new WeakMap<symbol, object>();
const liveValue = { tag: 2 };
liveMap.set(liveSymbol, liveValue);
const liveRef = new WeakRef(liveValue);
const deadMapValues: WeakRef<object>[] = [];
const deadSymbolValues: WeakRef<object>[] = [];

function dropSymbolKeyedEntries(): void {
  for (let i = 0; i < count; i++) {
    const map = new WeakMap<symbol, object>();
    const value = { map, i };
    map.set(liveSymbol, value);
    deadMapValues.push(new WeakRef(value));
    const first: { second?: object; symbol?: symbol } = {};
    first.second = { first };
    first.symbol = Symbol("dead");
    const held = { i };
    liveMap.set(first.symbol, held);
    deadSymbolValues.push(new WeakRef(held));
  }
}

console.log("freed weak maps:", freeChainedWeakMaps());
console.log("cleared maps are empty:", clearPinnedMaps());
dropSymbolKeyedEntries();
for (let round = 0; round < 5; round++) {
  Bun.gc(true);
  await new Promise(resolve => setTimeout(resolve, 0));
}
// A conservative stack scan may keep the last few objects of a loop alive.
const nearlyAll = count - 10;
const collected = (refs: WeakRef<object>[]) => refs.filter(ref => ref.deref() === undefined).length;
console.log("values of dropped maps collected:", collected(deadMapValues) >= nearlyAll);
console.log("values of dropped symbols collected:", collected(deadSymbolValues) >= nearlyAll);
console.log("live entry kept:", liveRef.deref() === liveMap.get(liveSymbol));
