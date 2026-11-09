(function (internal: BunWasm.Internal) {
  "use strict";
  type Graph = BunWasm.HotGraph;
  type Options = BunWasm.HotServeOptions;
  type Server = BunWasm.HotServer;
  type Snapshot = BunWasm.HotSnapshot;
  type Binding = { server: Server; hostname: string; port: number; revisions: BunWasm.HotRevisionController };
  type State = { kind: "absent" } | { kind: "provisional"; binding: Binding } | { kind: "committed"; binding: Binding; snapshot: Snapshot };
  const normalize = internal.require("net_hostname");
  const createRevisions = internal.require("hot_revisions");
  const context = () => internal.native.getAsyncContext();

  return function createHotServers(current: () => Graph | undefined): BunWasm.HotServers {
    let state: State = { kind: "absent" };
    let candidate: Graph | null = null;
    let stopped = false;
    let staged: Snapshot | null = null;
    let waiting: { resolve(snapshot: Snapshot): void; reject(error: unknown): void }[] = [];

    function fail(message: string): never { throw new Error(`--hot ${message}`); }

    function bind(options: Options): { hostname: string; port: number; fetch: BunWasm.HotFetch } {
      if (typeof options.fetch !== "function") return fail("requires one fetch-only Bun.serve call per evaluation");
      if (options.routes !== undefined || options.websocket !== undefined || options.tls !== undefined || options.unix !== undefined) {
        return fail("does not support routes, WebSockets, TLS or Unix listeners");
      }
      const port = Number(options.port ?? globalThis.process.env?.BUN_PORT ?? globalThis.process.env?.PORT ?? 3000);
      if (!Number.isInteger(port) || port <= 0 || port > 65535) return fail("requires a fixed nonzero port");
      const hostname = normalize(options.hostname || "0.0.0.0", true).toLowerCase().replace(/\.$/, "");
      return { hostname, port, fetch: options.fetch };
    }

    function serve(options: Options, create: (options: Options) => Server): Server {
      if (stopped) return fail("listener has been stopped");
      const owner = current();
      if (!candidate || owner !== candidate || owner.phase !== "candidate") return fail("Bun.serve called outside the current evaluation");
      if (staged) return fail("supports only one Bun.serve call per evaluation");
      const requested = bind(options);
      if (state.kind === "absent") {
        const server = create({ ...options, hostname: requested.hostname, port: requested.port });
        state = { kind: "provisional", binding: { server, hostname: requested.hostname, port: requested.port, revisions: createRevisions() } };
      }
      const { binding } = state;
      if (binding.hostname !== requested.hostname || binding.port !== requested.port) return fail("cannot change the listener address or port");
      staged = { stamp: binding.revisions.stamp(owner.id), fetch: requested.fetch, error: options.error, context: context(), graph: owner };
      return binding.server;
    }

    function release(snapshot: Snapshot): void {
      const graph = snapshot.graph;
      graph.leases--;
      if (graph.phase === "retired" && graph.leases === 0) graph.releaseDiagnostics();
    }

    function leased(snapshot: Snapshot): Snapshot { snapshot.graph.leases++; return snapshot; }

    function select(server: Server): Promise<Snapshot> {
      if (stopped) return Promise.reject(new Error("--hot listener has been stopped"));
      if (state.kind === "committed" && state.binding.server === server) return Promise.resolve(leased(state.snapshot));
      if (state.kind !== "provisional" || state.binding.server !== server) return Promise.reject(new Error("--hot listener is not active"));
      return new Promise<Snapshot>((resolve, reject) => waiting.push({ resolve: snapshot => resolve(leased(snapshot)), reject }));
    }

    function rejectWaiting(): void {
      const pending = waiting;
      waiting = [];
      for (const waiter of pending) waiter.reject(new Error("--hot initial server evaluation did not commit"));
    }

    function abort(graph: Graph): void {
      if (candidate !== graph) return;
      candidate = null;
      staged = null;
      if (state.kind !== "provisional") return;
      const { server, revisions } = state.binding;
      state = { kind: "absent" };
      rejectWaiting();
      // The state was cleared before stop, so provisional abort cannot close the runner.
      revisions.close();
      void server.stop(true);
    }

    function commit(graph: Graph): Server {
      if (candidate !== graph || !staged || state.kind === "absent") return fail("evaluation must register exactly one Bun.serve listener");
      const snapshot = staged;
      const { binding } = state;
      binding.server.reload({ fetch: snapshot.fetch, error: snapshot.error });
      state = { kind: "committed", binding, snapshot };
      candidate = null;
      staged = null;
      const pending = waiting;
      waiting = [];
      for (const waiter of pending) waiter.resolve(snapshot);
      return binding.server;
    }

    function revisions(server: Server): BunWasm.HotCommittedRevisions {
      if (state.kind === "absent" || state.binding.server !== server) return fail("server is not owned by this runner");
      return state.binding.revisions.source;
    }

    function close(server: Server): void {
      if (state.kind === "absent" || state.binding.server !== server) return;
      stopped = true;
      state.binding.revisions.close();
    }

    function publish(graph: Graph): void {
      if (state.kind !== "committed" || state.snapshot.graph !== graph) return fail("cannot publish an uncommitted graph");
      state.binding.revisions.commit(state.snapshot.stamp);
    }

    function dispose(): void {
      const previous = state;
      state = { kind: "absent" };
      candidate = null;
      staged = null;
      rejectWaiting();
      if (previous.kind !== "absent") { previous.binding.revisions.close(); void previous.binding.server.stop(true); }
    }

    return { serve, select, release, commit, abort, revisions, close, publish, dispose, begin(graph) { candidate = graph; staged = null; } };
  };
})
