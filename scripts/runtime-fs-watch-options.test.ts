import { expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

interface Watcher extends EventEmitter {
  close(): void;
}
interface WatchModule {
  watch(path: string, options: unknown): Watcher;
}

// Factory controls only. No Waffle subscription or event delivery is simulated.
function watchOptions() {
  const effects = { stats: 0, opens: 0, closes: 0 };
  const waiters = new Set<unknown>();
  const internal = {
    native: {
      fsWatchOpen() { return 30 + effects.opens++; },
      procRead: () => -6,
      procClose() { effects.closes++; return 0; },
    },
    require(name: string) {
      if (name === "events") return EventEmitter;
      if (name === "buffer") return { Buffer };
      if (name === "net") return {};
      throw new Error(`Unexpected module ${name}`);
    },
    addIoWaiter: (waiter: unknown) => { waiters.add(waiter); return waiter; },
    removeIoWaiter: (waiter: unknown) => waiters.delete(waiter),
    nextTick: queueMicrotask,
  };
  const filesystem = {
    statSync() {
      effects.stats++;
      return {};
    },
    toPath: (path: string) => path,
    absolute: (path: string) => path,
  };
  const source = readFileSync(new URL("../crates/bunwasm-runtime/src/js/fs_watch.ts", import.meta.url), "utf8");
  const factory = runInNewContext(new Bun.Transpiler({ loader: "ts" }).transformSync(`globalThis.__factory = ${source}`), { AbortSignal });
  const module: WatchModule = factory(internal)(filesystem);
  return { module, effects };
}

const invalidOptions = ["not-an-encoding", "buffer!", "utf9", 7, {}].flatMap<unknown>(encoding =>
  typeof encoding === "string" ? [encoding, { encoding }] : [{ encoding }]);
test.each(invalidOptions)("watch rejects %j before filesystem or watch registration", value => {
  const { module, effects } = watchOptions();
  let watcher: Watcher | undefined;
  try {
    expect(() => { watcher = module.watch("/fixture.txt", value); }).toThrow(expect.objectContaining({ code: "ERR_INVALID_ARG_VALUE" }));
    expect(effects).toEqual({ stats: 0, opens: 0, closes: 0 });
  } finally { watcher?.close(); }
});

for (const value of [undefined, null, "", { encoding: "" }, { encoding: null }, { encoding: undefined }, "utf8", "buffer", { encoding: "utf16le" }]) {
  test(`watch accepts supported encoding options ${JSON.stringify(value)}`, () => {
    const { module, effects } = watchOptions();
    const watcher = module.watch("/fixture.txt", value);
    try { expect(watcher).toBeInstanceOf(EventEmitter); }
    finally { watcher.close(); }
    expect(effects).toEqual({ stats: 1, opens: 1, closes: 1 });
  });
}
