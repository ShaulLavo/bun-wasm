(function (internal: BunWasm.Internal) {
  "use strict";
  type Stamp = BunWasm.HotCommittedStamp;
  type Notice = BunWasm.HotCommitNotice;
  const NativeMap = Map;
  const freeze = Object.freeze;
  const random = internal.native.randomBytes;

  return function createRevisions(): BunWasm.HotRevisionController {
    const token = Array.from(random(16), byte => byte.toString(16).padStart(2, "0")).join("");
    const observers = new NativeMap<object, (notice: Notice) => void>();
    let current: Stamp | null = null;
    let closed = false;

    function deliver(key: object, observer: (notice: Notice) => void, notice: Notice): void {
      try { observer(notice); }
      catch (error) { observers.delete(key); internal.printError(error); }
    }

    function notify(notice: Notice): void {
      // Snapshot recipients. An observer may unsubscribe or register another observer.
      const batch = Array.from(observers);
      for (const [key, observer] of batch) if (observers.has(key)) deliver(key, observer, notice);
    }

    const source: BunWasm.HotCommittedRevisions = freeze({
      subscribe(observer: (notice: Notice) => void) {
        if (typeof observer !== "function") throw new TypeError("Expected a hot revision observer");
        const key = {};
        if (closed) { deliver(key, observer, { kind: "closed" }); return () => {}; }
        observers.set(key, observer);
        if (current) deliver(key, observer, { kind: "committed", stamp: current });
        return () => { observers.delete(key); };
      },
    });

    return {
      source,
      stamp(revision) {
        if (!Number.isSafeInteger(revision) || revision <= 0) throw new TypeError("Invalid committed hot generation");
        return freeze({ server: token, revision });
      },
      commit(stamp) {
        if (closed) throw new Error("--hot listener has been stopped");
        if (stamp.server !== token || current && stamp.revision <= current.revision) throw new Error("Invalid hot commit order");
        current = stamp;
        notify({ kind: "committed", stamp });
      },
      close() {
        if (closed) return;
        closed = true;
        current = null;
        notify({ kind: "closed" });
        observers.clear();
      },
    };
  };
})
