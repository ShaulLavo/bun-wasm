(function (internal: Pick<BunWasm.Internal, "builtin"> & {
  isPromise(value: unknown): boolean;
  promiseThen(value: unknown, fulfilled: () => void, rejected: (error: unknown) => void): unknown;
}) {
  type DescribeCallback = () => unknown;
  type CollectionState =
    | { kind: "queued"; callback: DescribeCallback; frame: RegistrationFrame }
    | { kind: "collecting" }
    | { kind: "collected" }
    | { kind: "failed"; error: unknown };

  interface CollectionScope {
    readonly kind: "scope";
    collection: CollectionState;
    readonly children: readonly CollectionNode[];
  }
  type CollectionNode = CollectionScope | { readonly kind: "test" };
  interface RunnerFile {
    readonly path: string;
    readonly root: CollectionScope;
    hasOnly: boolean;
  }
  type FilePhase =
    | { kind: "importing"; admitted: RegistrationFrame }
    | { kind: "collecting"; admitted: RegistrationFrame | null }
    | { kind: "closed" };
  interface FileCollection {
    readonly file: RunnerFile;
    phase: FilePhase;
  }
  interface RegistrationFrame {
    readonly owner: FileCollection;
    readonly scope: CollectionScope;
  }
  interface CollectionSession {
    enterRoot<T>(load: () => T): T;
    enqueue(scope: CollectionScope, callback: DescribeCallback | null): void;
    collect(): Promise<void>;
    close(): void;
  }
  type Queued = Extract<CollectionState, { kind: "queued" }>;
  type Report = (error: unknown) => void;
  const NativePromise = Promise;
  const { isPromise, promiseThen } = internal;
  const { AsyncLocalStorage } = internal.builtin("node:async_hooks");
  const frames = new AsyncLocalStorage<RegistrationFrame>();

  function registrationFrame(): RegistrationFrame {
    const frame = frames.getStore();
    if (!frame) throw new Error("Cannot call test() or describe() outside of a test file");
    const phase = frame.owner.phase;
    if (phase.kind === "closed") throw new Error("Cannot register from a closed test collection");
    if (phase.admitted !== frame || frame.scope.collection.kind !== "collecting") {
      throw new Error("Cannot register from a non-admitted test collection scope");
    }
    return frame;
  }

  function executionRegistrationFrame(): RegistrationFrame | null {
    return frames.getStore() === undefined ? null : registrationFrame();
  }

  function enqueue(owner: FileCollection, scope: CollectionScope, callback: DescribeCallback | null): void {
    if (registrationFrame().owner !== owner) throw new Error("Cannot enqueue in another test collection");
    scope.collection = callback === null ? { kind: "collected" } : {
      kind: "queued", callback, frame: Object.freeze({ owner, scope }),
    };
  }

  function revoke(frame: RegistrationFrame): void {
    const { owner } = frame;
    if (owner.phase.kind === "collecting" && owner.phase.admitted === frame) {
      owner.phase = { kind: "collecting", admitted: null };
    }
  }

  function complete(scope: CollectionScope, queued: Queued, done: () => void): void {
    revoke(queued.frame);
    scope.collection = { kind: "collected" };
    done();
  }

  function fail(scope: CollectionScope, queued: Queued, error: unknown, report: Report, done: () => void): void {
    revoke(queued.frame);
    scope.collection = { kind: "failed", error };
    try { report(error); } finally { done(); }
  }

  function observe(scope: CollectionScope, queued: Queued, report: Report, done: () => void): void {
    try {
      const callback = queued.callback;
      const result = callback();
      if (!isPromise(result)) return complete(scope, queued, done);
      promiseThen(result,
        () => { complete(scope, queued, done); },
        error => { fail(scope, queued, error, report, done); });
    } catch (error) {
      fail(scope, queued, error, report, done);
    }
  }

  function failed(scope: CollectionScope): boolean {
    return scope.collection.kind === "failed";
  }

  async function collectScope(owner: FileCollection, scope: CollectionScope, report: Report): Promise<void> {
    if (owner.phase.kind === "closed" || scope.collection.kind !== "queued") return;
    const queued = scope.collection;
    scope.collection = { kind: "collecting" };
    owner.phase = { kind: "collecting", admitted: queued.frame };
    await frames.run(queued.frame, () => new NativePromise<void>(done => observe(scope, queued, report, done)));
    if (failed(scope)) return;
    await collectChildren(owner, scope, report);
  }

  async function collectChildren(owner: FileCollection, scope: CollectionScope, report: Report): Promise<void> {
    for (let index = 0; index < scope.children.length; index++) {
      if (owner.phase.kind === "closed") return;
      const child = scope.children[index];
      if (child.kind === "scope") await collectScope(owner, child, report);
    }
  }

  async function collect(owner: FileCollection, report: Report): Promise<void> {
    if (owner.phase.kind !== "importing") throw new Error("Test collection has already closed or started");
    owner.phase = { kind: "collecting", admitted: null };
    owner.file.root.collection = { kind: "collected" };
    await collectChildren(owner, owner.file.root, report);
  }

  function enterRoot<T>(frame: RegistrationFrame, load: () => T): T {
    if (frame.owner.phase.kind !== "importing") throw new Error("Cannot reopen test collection");
    return frames.run(frame, load);
  }

  function createSession(file: RunnerFile, report: Report): CollectionSession {
    const owner: FileCollection = { file, phase: { kind: "closed" } };
    const frame = Object.freeze({ owner, scope: file.root });
    owner.phase = { kind: "importing", admitted: frame };
    file.root.collection = { kind: "collecting" };
    return {
      enterRoot: load => enterRoot(frame, load),
      enqueue: (scope, callback) => enqueue(owner, scope, callback),
      collect: () => collect(owner, report),
      close() { owner.phase = { kind: "closed" }; },
    };
  }

  return { createSession, registrationFrame, executionRegistrationFrame };
})
