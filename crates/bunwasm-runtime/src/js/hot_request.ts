(function (internal: BunWasm.Internal) {
  "use strict";
  async function run<T>(servers: BunWasm.HotServers, server: BunWasm.HotServer, connection: { closed: boolean },
    dispatch: (snapshot: BunWasm.HotSnapshot, releaseOnAbort: (signal: AbortSignal) => void) => Promise<T>): Promise<T> {
    const snapshot = await servers.select(server);
    let released = false;
    let signal: AbortSignal | null = null;
    const release = () => {
      if (released) return;
      released = true;
      signal?.removeEventListener("abort", release);
      servers.release(snapshot);
    };
    const releaseOnAbort = (value: AbortSignal) => {
      signal = value;
      if (signal.aborted || connection.closed) release();
      else signal.addEventListener("abort", release, { once: true });
    };
    try {
      return await internal.runInContext(snapshot.context, dispatch, undefined, [snapshot, releaseOnAbort]);
    } finally {
      release();
    }
  }
  return { run };
})
