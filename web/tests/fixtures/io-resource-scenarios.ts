// Cases for io-resource-context.ts. Each registers in frame A; the host then pumps at root (hook
// path) or in an unrelated ambient frame (native provider). `see(site, ...)` records the frame.

export const CASES: Record<string, string> = {
  "spawn stdin callback failure closes IPC": spawnFailureRetirement("stdin").join("\n"),
  "spawn abort cleanup failure closes IPC": spawnFailureRetirement("abort").join("\n"),
  "watch change": `
    const watcher = watch("/app", function () { see("change", this === watcher); });
    state.watch.push(record);`,
  "watch error": `
    const watcher = watch("/app", () => {});
    watcher.on("error", error => see("error", error.code));
    watcher.on("close", () => see("close"));
    state.watch.push(-29);`,
  // A change listener closes its watcher and then throws: the error still belongs to that dispatch.
  "watch close then throw": `
    const thrown = new Error("listener");
    const watcher = watch("/app", () => { see("change"); watcher.close(); throw thrown; });
    watcher.on("error", error => see("error", error === thrown));
    watcher.on("close", () => see("close"));
    state.watch.push(record);`,
  // An error listener throws after the error closed the watcher; the rethrown error is delivered
  // to the same listener in the same frame.
  "watch error listener throws": `
    const thrown = new Error("error listener");
    let calls = 0;
    const watcher = watch("/app", () => {});
    watcher.on("error", error => { see("error", calls === 0 ? error.code : error === thrown); if (calls++ === 0) throw thrown; });
    watcher.on("close", () => see("close"));
    state.watch.push(-29);`,
  // A synchronous pump in the caller's own frame hands that frame back, also across a throw.
  "watch caller pump": `
    const thrown = new Error("listener");
    const watcher = watch("/app", () => { see("change"); watcher.close(); throw thrown; });
    watcher.on("error", error => see("error", error === thrown));
    watcher.on("close", () => see("close"));
    state.watch.push(record);
    storage.run("caller", () => { internal.pumpIo(); see("caller"); });`,
  // Caller close and abort keep their caller's frame, as before.
  "watch caller close": `
    const watcher = watch("/app", () => {});
    watcher.on("close", () => see("close"));
    storage.run("C", () => watcher.close());`,
  "watch abort": `
    const controller = storage.run("root", () => new AbortController());
    const watcher = watch("/app", { signal: controller.signal }, () => {});
    watcher.on("close", () => see("close"));
    storage.run("D", () => controller.abort());`,
  "watch two stores": `
    const one = storage.run("one", () => watch("/one", () => see("one")));
    const two = storage.run("two", () => watch("/two", () => see("two")));
    state.watches[0].push(record);
    state.watches[1].push(record);
    internal.nextTick(() => { one.close(); two.close(); });`,
  // A watcher closed by another's listener earlier in the same pump turn delivers nothing more.
  "watch closed earlier in the turn": `
    const other = storage.run("other", () => watch("/other", () => { see("other"); watcher.close(); }));
    const watcher = watch("/app", () => see("stale"));
    watcher.on("close", () => see("close"));
    state.watches[0].push(record);
    state.watches[1].push(record);
    internal.nextTick(() => other.close());`,
  // onExit keeps its receiver and arguments; the exited reaction keeps the frame it was attached in.
  "spawn onExit": `
    const options = { stdio: ["inherit", "inherit", "inherit"], onExit(exited, code, signal, error) {
      see("onExit", this === child.options, exited === child, code, signal, error);
    } };
    const child = modules.spawn.spawn(["bun", "-e", ""], options);
    child.options = options;
    storage.run("reaction", () => child.exited.then(code => see("exited reaction", code)));
    state.exited = true;`,
  "spawn startup error": `
    const child = modules.spawn.spawn(["bun", "-e", ""], { stdio: ["inherit", "inherit", "inherit"], onExit(_child, code, signal, error) {
      see("onExit", code, signal, error.code);
    } });
    storage.run("reaction", () => child.exited.catch(error => see("exited reaction", error.code)));
    state.exited = [2, 44];`,
  // A throwing onExit has nothing more to run in the spawn frame; its error fails the child.
  "spawn onExit throws": `
    const child = modules.spawn.spawn(["bun", "-e", ""], { stdio: ["inherit", "inherit", "inherit"], onExit() {
      see("onExit");
      internal.realTimers.setImmediate(() => see("queued by onExit"));
      throw new Error("onExit");
    } });
    storage.run("reaction", () => child.exited.then(code => see("exited reaction", code)));
    state.exited = true;`,
  // Node's spawn event comes from the startup notification; exit and close from exited reactions.
  "node spawn events": `
    const child = modules.spawn.nodeChildProcess().spawn("bun", ["-e", ""], { stdio: "inherit" });
    for (const name of ["spawn", "exit", "close"]) child.on(name, () => see(name));
    state.exited = true;`,
  // Channel events: a message, then end of input.
  "ipc message and end": `
    const target = new modules.events();
    target.on("message", message => see("message", message.n));
    target.on("disconnect", () => see("disconnect"));
    const ipc = modules.child_ipc.open(target, { input: 3, output: 4 });
    state.reads.push(Buffer.from('{"n":1}\\n'), 0);`,
  // A disconnect the caller asks for keeps the caller's frame, as before.
  "ipc caller disconnect": `
    state.writable = true;
    const target = new modules.events();
    target.on("disconnect", () => see("disconnect"));
    const ipc = modules.child_ipc.open(target, { input: 3, output: 4 });
    storage.run("C", () => ipc.disconnect());`,
  "ipc immediate send": `
    state.writable = true;
    const ipc = modules.child_ipc.open(new modules.events(), { input: 3, output: 4 });
    storage.run("B", () => ipc.send({ n: 1 }, error => see("send", error)));`,
  // A send completed by a later pump is not the channel's event: it keeps the frame it is queued
  // in, as before (native Bun reports no frame there; Node the send's).
  "ipc blocked send": `
    const ipc = modules.child_ipc.open(new modules.events(), { input: 3, output: 4 });
    storage.run("B", () => ipc.send({ n: 1 }, error => see("send", error)));
    internal.realTimers.setImmediate(() => { state.writable = true; });`,
  // The child's exit drains the channel from spawn's own step, outside the channel's waiter.
  "ipc drained at exit": `
    const child = modules.spawn.nodeChildProcess().spawn("bun", ["-e", ""], { stdio: ["inherit", "inherit", "inherit", "ipc"] });
    child.on("message", message => see("message", message.n));
    child.on("disconnect", () => see("disconnect"));
    child.on("exit", () => see("exit"));
    state.reads.push(Buffer.from('{"n":1}\\n{"n":2}\\n'));
    state.exited = true;`,
  // A partial message at exit fails the drain; the channel still ends as its own event.
  "ipc partial message at exit": `
    const child = modules.spawn.nodeChildProcess().spawn("bun", ["-e", ""], { stdio: ["inherit", "inherit", "inherit", "ipc"] });
    child.on("message", message => see("message", message.n));
    child.on("disconnect", () => see("disconnect"));
    child.on("error", error => see("error", error.message));
    child.send({ n: 0 }, error => see("pending send", error.code));
    state.reads.push(Buffer.from('{"n":1}\\n{"n":'), 0);
    state.exited = true;`,
  // finish() from another frame still delivers in the channel's.
  "ipc finish from another frame": `
    const target = new modules.events();
    target.on("message", message => see("message", message.n));
    target.on("disconnect", () => see("disconnect"));
    const ipc = modules.child_ipc.open(target, { input: 3, output: 4 });
    state.reads.push(Buffer.from('{"n":1}\\n'), 0);
    storage.run("S", () => ipc.finish());`,
  // stdin: data and end run in the frame of the read that delivered them (native Bun).
  "stdin construct A, read B": `
    const stdin = modules.process_stdin();
    storage.run("B", () => { stdin.on("data", chunk => see("data", String(chunk))); stdin.on("end", () => see("end")); stdin.resume(); });
    state.reads.push(Buffer.from("one"), 0);`,
  "stdin construct root, read B": `
    const stdin = storage.run(undefined, () => modules.process_stdin());
    storage.run("B", () => { stdin.on("data", chunk => see("data", String(chunk))); stdin.on("end", () => see("end")); stdin.resume(); });
    state.reads.push(Buffer.from("one"), 0);`,
  "stdin construct A, read root": `
    const stdin = modules.process_stdin();
    storage.run(undefined, () => { stdin.on("data", chunk => see("data", String(chunk))); stdin.on("end", () => see("end")); stdin.resume(); });
    state.reads.push(Buffer.from("one"), 0);`,
  // After the first data, a read(0) in D starts the next read: the rest arrives in D.
  "stdin next read D": `
    const stdin = modules.process_stdin();
    storage.run("B", () => {
      stdin.on("data", chunk => { see("data", String(chunk)); if (String(chunk) === "one") { storage.run("D", () => stdin.read(0)); internal.realTimers.setImmediate(() => state.reads.push(Buffer.from("two"), 0)); } });
      stdin.on("end", () => see("end"));
      stdin.resume();
    });
    state.reads.push(Buffer.from("one"));`,
  // Paused in C, resumed in D, more input only after: the rest arrives in D.
  "stdin pause C, resume D": `
    const stdin = modules.process_stdin();
    storage.run("B", () => {
      stdin.on("data", chunk => {
        see("data", String(chunk));
        if (String(chunk) !== "one") return;
        storage.run("C", () => stdin.pause());
        internal.realTimers.setImmediate(() => { storage.run("D", () => stdin.resume()); internal.realTimers.setImmediate(() => state.reads.push(Buffer.from("two"), 0)); });
      });
      stdin.on("end", () => see("end"));
      stdin.resume();
    });
    state.reads.push(Buffer.from("one"));`,
  // Resumed in C, then a read(0) in D while C's read is pending: the rest arrives in C.
  "stdin resume C, read D pending": `
    const stdin = modules.process_stdin();
    storage.run("B", () => {
      stdin.on("data", chunk => {
        see("data", String(chunk));
        if (String(chunk) !== "one") return;
        storage.run("C", () => stdin.pause());
        internal.realTimers.setImmediate(() => {
          storage.run("C", () => stdin.resume());
          internal.realTimers.setImmediate(() => { storage.run("D", () => stdin.read(0)); internal.realTimers.setImmediate(() => state.reads.push(Buffer.from("two"), 0)); });
        });
      });
      stdin.on("end", () => see("end"));
      stdin.resume();
    });
    state.reads.push(Buffer.from("one"));`,
  // A data listener destroys stdin and then throws: the read's failure is its own, with nothing
  // more to deliver, and close keeps the read's frame.
  "stdin destroyed in data, then throws": `
    const stdin = modules.process_stdin();
    storage.run("B", () => {
      stdin.on("data", () => { see("data"); stdin.destroy(); throw new Error("listener"); });
      stdin.on("error", error => see("error", error.message));
      stdin.on("close", () => see("close"));
      stdin.resume();
    });
    state.reads.push(Buffer.from("one"));`,
  "stdin read error": `
    const stdin = modules.process_stdin();
    storage.run("B", () => { stdin.on("error", error => see("error", error.code)); stdin.on("close", () => see("close")); stdin.resume(); });
    state.reads.push(-29);`,
  // Bun.serve: an explicit frame at serve() is where its requests run. Routes dispatch before any
  // await; a fetch handler after the server's internal await needs prepared source on the hook path.
  "serve explicit frame": `
    modules.net.serve({ hostname: "127.0.0.1", port: 1234, routes: { "/": () => { see("route"); return new Response("ok"); } } });
    state.input.push(Buffer.from("GET / HTTP/1.1\\r\\nHost: localhost\\r\\nConnection: close\\r\\n\\r\\n"));`,
  "serve run frame": `
    storage.run("A", () => modules.net.serve({ hostname: "127.0.0.1", port: 1234, routes: { "/": () => { see("route"); return new Response("ok"); } } }));
    state.input.push(Buffer.from("GET / HTTP/1.1\\r\\nHost: localhost\\r\\nConnection: close\\r\\n\\r\\n"));`,
  // Started outside any frame, a request keeps the turn's own frame, unchanged per mode.
  "serve root registration": `
    native.setAsyncContext(undefined);
    modules.net.serve({ hostname: "127.0.0.1", port: 1234, routes: { "/": () => { see("route"); return new Response("ok"); } } });
    state.input.push(Buffer.from("GET / HTTP/1.1\\r\\nHost: localhost\\r\\nConnection: close\\r\\n\\r\\n"));`,
};

function spawnFailureRetirement(fault: "stdin" | "abort"): readonly string[] {
  const stdio = fault === "stdin" ? '["pipe", "pipe", "inherit"]' : '["inherit", "inherit", "inherit"]';
  const trigger = fault === "stdin" ? "state.reads.push(-29);" : `
    state.reads.push(Buffer.from('{"n":1}\\n{"unfinished":'), 0); state.exited = true;`;
  return [
    `const added = [];
     const add = internal.addIoWaiter;
     internal.addIoWaiter = waiter => { added.push(waiter); return add(waiter); };
     const open = modules.child_ipc.open;
     modules.child_ipc.open = (...args) => storage.run({ frame: "channel-A" }, () => {
       globalThis.marker = new WeakRef(storage.getStore()); return open(...args);
     });
     const target = new modules.events();
     target.on("disconnect", () => see("disconnect"));
     const cleanupError = new Error("cleanup callback");
     const controller = new AbortController();
     const originalRemove = controller.signal.removeEventListener;
     const child = storage.run("spawn-S", () => modules.spawn.spawn(["bun", "-e", ""], {
       stdio: ${stdio}, _ipc: true, _ipcTarget: target, signal: controller.signal
     }));
     child.exited.catch(() => {});
     const channel = target.channel;
     ${fault === "stdin" ? 'child.stdin.write("blocked", () => { throw cleanupError; });' : 'controller.signal.removeEventListener = () => { throw cleanupError; };'}`,
    `${trigger}
     const waiter = added[added.length - 1];
     storage.run("caller-C", () => {
       try { waiter.step(); } catch (error) {
         internal.removeIoWaiter(waiter);
         assert.throws(() => waiter.fail(error), thrown => thrown === cleanupError);
       }
       see("caller restored");
     });
     controller.signal.removeEventListener = originalRemove;
     internal.runTicks();
     assert.equal(channel.connected, false);
     assert.deepEqual(records, [["caller restored", "caller-C"], ["disconnect", "channel-A"]]);
     assert.deepEqual(state.closed.slice().sort((a, b) => a - b), Array.from({ length: state.fd - 10 }, (_, i) => i + 10));`,
  ];
}

// Retirement steps for io-resource-context.ts, each followed by a reachability check of the
// `marker` frame. Every scenario retains its resource (and through it, its waiter).
export const RETIREMENT: Record<string, readonly string[]> = {
  "spawn stdin callback throws with IPC open": spawnFailureRetirement("stdin"),
  "spawn abort removal throws with IPC open": spawnFailureRetirement("abort"),
  // Live, then closed by its caller with no later pump.
  "watch closed without a pump": [
    `var watcher = storage.run({ frame: "marker" }, () => { globalThis.marker = new WeakRef(storage.getStore()); return watch("/app", () => {}); });`,
    "watcher.close();",
  ],
  // Closed during its own dispatch: an immediate the listener queued keeps the frame until it
  // runs, and nothing after it.
  "watch closed in its dispatch": [
    `var watcher = storage.run({ frame: "marker" }, () => { globalThis.marker = new WeakRef(storage.getStore());
      return watch("/app", () => { internal.realTimers.setImmediate(() => see("queued")); watcher.close(); }); });`,
    "state.watch.push(record); internal.pumpIo();",
    "internal.runTimers();",
  ],
  // Closed by its listener, which then throws; the failure frame is not kept after fail.
  "watch close then throw": [
    `var watcher = storage.run({ frame: "marker" }, () => { globalThis.marker = new WeakRef(storage.getStore());
      return watch("/app", () => { watcher.close(); throw new Error("listener"); }); });
     watcher.on("error", () => see("error"));`,
    "state.watch.push(record); internal.pumpIo();",
  ],
  // Another watcher's listener closes this one before its own step in the same pump turn.
  "watch closed earlier in the turn": [
    `var other = storage.run("other", () => watch("/other", () => watcher.close()));
     var watcher = storage.run({ frame: "marker" }, () => { globalThis.marker = new WeakRef(storage.getStore());
      return watch("/app", () => see("stale")); });`,
    "state.watches[0].push(record); state.watches[1].push(record); internal.pumpIo(); other.close();",
  ],
  // The spawn frame outlives its child only until onExit, whether or not there is one.
  "spawn exits": [
    `var child = storage.run({ frame: "marker" }, () => { globalThis.marker = new WeakRef(storage.getStore());
      return modules.spawn.spawn(["bun", "-e", ""], { stdio: ["inherit", "inherit", "inherit"], onExit() { see("onExit"); } }); });`,
    "state.exited = true; internal.pumpIo();",
  ],
  "spawn exits without onExit": [
    `var child = storage.run({ frame: "marker" }, () => { globalThis.marker = new WeakRef(storage.getStore());
      return modules.spawn.spawn(["bun", "-e", ""], { stdio: ["inherit", "inherit", "inherit"] }); });`,
    "state.exited = true; internal.pumpIo();",
  ],
  // A stdin write callback throws while exit tears stdin down, before onExit could run.
  // A stopped server lets its frame go, even while the server object stays reachable.
  "serve stopped": [
    `var server = storage.run({ frame: "marker" }, () => { globalThis.marker = new WeakRef(storage.getStore());
      return modules.net.serve({ hostname: "127.0.0.1", port: 1234, routes: { "/": () => new Response("ok") } }); });`,
    "server.stop(true);",
  ],
  "ipc closed by its caller": [
    `var ipc = storage.run({ frame: "marker" }, () => { globalThis.marker = new WeakRef(storage.getStore());
      return modules.child_ipc.open(new modules.events(), { input: 3, output: 4 }); });`,
    "ipc.close();",
  ],
  "ipc ended by its input": [
    `var ipc = storage.run({ frame: "marker" }, () => { globalThis.marker = new WeakRef(storage.getStore());
      return modules.child_ipc.open(new modules.events(), { input: 3, output: 4 }); });`,
    "state.reads.push(0); internal.pumpIo();",
  ],
  "stdin destroyed with a read pending": [
    `var stdin = storage.run({ frame: "marker" }, () => { globalThis.marker = new WeakRef(storage.getStore());
      const stream = modules.process_stdin(); stream.on("data", () => {}); stream.resume(); return stream; });
     internal.runTicks();`,
    "stdin.destroy();",
  ],
  "stdin read to its end": [
    `var stdin = storage.run({ frame: "marker" }, () => { globalThis.marker = new WeakRef(storage.getStore());
      const stream = modules.process_stdin(); stream.on("data", () => {}); stream.resume(); return stream; });
     internal.runTicks();`,
    "state.reads.push(Buffer.from('x'), 0); internal.pumpIo();",
    "internal.pumpIo();",
  ],
  // Exit cancels waiters but closes no resource: a live watcher keeps its frame until the realm ends.
  "watch at exit cancellation": [
    `var watcher = storage.run({ frame: "marker" }, () => { globalThis.marker = new WeakRef(storage.getStore()); return watch("/app", () => {}); });`,
    "internal.cancelIoWaiters();",
  ],
  "spawn cleanup throws": [
    `var child = storage.run({ frame: "marker" }, () => { globalThis.marker = new WeakRef(storage.getStore());
      return modules.spawn.spawn(["bun", "-e", ""], { stdio: ["pipe", "inherit", "inherit"], onExit() { see("onExit"); } }); });
     child.stdin.write("blocked", () => { throw new Error("write callback"); });`,
    "state.exited = true; internal.pumpIo(); child.exited.catch(() => {});",
  ],
};
