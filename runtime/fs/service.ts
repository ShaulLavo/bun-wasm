import { MemoryBackend, type FilesystemBackend } from "./backend";
import { HEADER, State, FilesystemError, errno, isRevoked, pack, unpack, wake, type FilesystemConnection, type RequestMessage } from "./protocol";

const mutations = new Set(["preopen", "write", "append", "resize", "setMtime", "create", "link", "removePath", "rename", "writeFile", "mkdirp", "remove", "move"]);
const TRANSIENT_HANDLES = 256;
interface Session {
  connection: FilesystemConnection;
  handles: Set<number>;
  preopens: Set<number>;
  transient: Map<number, true>;
  references: Map<number, number>;
  responses: Map<number, Uint8Array>;
  pending: Map<number, SharedArrayBuffer>;
}
/** One serial owner of the tree. No request ever waits for a guest acknowledgment. */
export class FilesystemService {
  private sessions = new Set<Session>();
  private queue = Promise.resolve();
  constructor(private backend: FilesystemBackend) {}
  connect(connection: FilesystemConnection): void {
    const session: Session = { connection, handles: new Set(), preopens: new Set(), transient: new Map(), references: new Map(), responses: new Map(), pending: new Map() };
    this.sessions.add(session);
    connection.port.onmessage = ({ data }: MessageEvent<RequestMessage>) => {
      if ("connect" in data) {
        if (!isRevoked(connection)) this.connect(data.connect);
        else data.connect.port.close();
      } else if ("sweep" in data) this.sweep();
      else if ("discard" in data) session.responses.delete(data.discard);
      else {
        session.pending.set(data.id, data.buffer);
        this.queue = this.queue.then(() => this.request(session, data.id, data.buffer));
      }
    };
    connection.port.start();
  }
  private pin(session: Session, handle: number | undefined, preopen = false): void {
    if (handle === undefined) return;
    if (!session.handles.has(handle)) {
      this.backend.retain(handle);
      session.handles.add(handle);
    }
    if (preopen) session.preopens.add(handle);
    if (session.preopens.has(handle) || session.references.has(handle)) session.transient.delete(handle);
    else {
      session.transient.delete(handle);
      session.transient.set(handle, true);
    }
  }
  private trim(session: Session): void {
    if (session.transient.size <= TRANSIENT_HANDLES) return;
    // Eviction changes capability validity, even for a read-only resolve. Invalidate client path
    // caches before releasing the pin; an enclosing mutation already owns the odd epoch.
    const epoch = new Int32Array(session.connection.epoch);
    const invalidate = !(Atomics.load(epoch, 0) & 1);
    if (invalidate) Atomics.add(epoch, 0, 1);
    try {
      while (session.transient.size > TRANSIENT_HANDLES) {
        const oldest = session.transient.keys().next().value!;
        session.transient.delete(oldest);
        session.handles.delete(oldest);
        this.backend.release(oldest);
      }
    } finally { if (invalidate) Atomics.add(epoch, 0, 1); }
  }
  private check(session: Session, handle: number | undefined): void {
    if (handle === undefined) return;
    if (!session.handles.has(handle)) throw new FilesystemError(8);
    if (session.transient.delete(handle)) session.transient.set(handle, true);
  }
  private async execute(session: Session, id: number, operation: string, args: any[], data: Uint8Array): Promise<unknown> {
    const [a, b, c] = args;
    if (operation === "take") {
      const response = session.responses.get(a);
      if (!response) throw new FilesystemError(11);
      const part = response.slice(b, b + c);
      if (b + c >= response.length) session.responses.delete(a);
      return part;
    }
    if (["retain", "release", "stat", "read", "write", "append", "resize", "setMtime", "readdir", "resolve"].includes(operation)) this.check(session, a);
    if (["create", "link", "removePath", "rename"].includes(operation)) {
      this.check(session, a.parent); this.check(session, a.node);
      if (operation === "link" || operation === "rename") { this.check(session, b.parent); this.check(session, b.node); }
    }
    if (operation === "retain") {
      session.references.set(a, (session.references.get(a) ?? 0) + 1);
      session.transient.delete(a);
      return;
    }
    if (operation === "release") {
      const count = session.references.get(a) ?? 0;
      if (!count) throw new FilesystemError(8);
      if (count > 1) session.references.set(a, count - 1);
      else {
        session.references.delete(a);
        session.handles.delete(a);
        session.preopens.delete(a);
        this.backend.release(a);
      }
      return;
    }
    const result: any = await this.backend.execute(operation, args, data);
    const pending = session.pending.get(id);
    if (isRevoked(session.connection) || !this.sessions.has(session) || !pending || Atomics.load(new Int32Array(pending, 0, HEADER / 4), 6)) throw new FilesystemError(11);
    if (operation === "preopen" || operation === "create" && typeof result === "number") this.pin(session, result, operation === "preopen");
    // Touch every returned identity before choosing an eviction victim: a new parent may point
    // to a hard-linked node that was previously the oldest transient capability.
    if (operation === "resolve" && typeof result !== "number") { this.pin(session, result.parent); this.pin(session, result.node); }
    this.trim(session);
    return result;
  }
  private async request(session: Session, id: number, buffer: SharedArrayBuffer): Promise<void> {
    const cells = new Int32Array(buffer, 0, HEADER / 4);
    const bytes = new Uint8Array(buffer, HEADER);
    let state = State.Complete;
    let mutation = false;
    const epoch = new Int32Array(session.connection.epoch);
    try {
      if (isRevoked(session.connection) || !this.sessions.has(session) || Atomics.load(cells, 6)) throw new FilesystemError(11);
      const inputLength = cells[1]!;
      const dataLength = cells[2]!;
      const { operation, args } = unpack(bytes.subarray(0, inputLength));
      mutation = mutations.has(operation);
      if (mutation) Atomics.add(epoch, 0, 1); // odd: invalidate caches before touching bytes
      const value = await this.execute(session, id, operation, args, bytes.subarray(inputLength, inputLength + dataLength));
      const binary = value instanceof Uint8Array;
      const result = binary ? value : pack(value);
      cells[2] = result.length;
      cells[4] = binary ? 1 : 0;
      if (result.length > bytes.length) {
        session.responses.set(id, result);
        state = State.Overflow;
      } else bytes.set(result);
    } catch (error) {
      cells[3] = errno(error);
      state = cells[3] === 11 ? State.Cancelled : State.Failed;
    } finally {
      if (mutation) Atomics.add(epoch, 0, 1);
      cells[5] = Atomics.load(epoch, 0);
      if (isRevoked(session.connection) || Atomics.load(cells, 6)) {
        session.responses.delete(id);
        state = State.Cancelled;
      }
      Atomics.store(cells, 0, state);
      Atomics.notify(cells, 0);
      wake(session.connection);
      session.pending.delete(id);
      session.connection.port.postMessage({ completed: id });
      this.sweep();
    }
  }
  sweep(): void {
    for (const session of this.sessions) if (isRevoked(session.connection)) this.close(session);
  }
  private close(session: Session): void {
    for (const [id, buffer] of session.pending) {
      const cells = new Int32Array(buffer, 0, HEADER / 4);
      Atomics.store(cells, 6, 1);
      Atomics.store(cells, 0, State.Cancelled);
      Atomics.notify(cells, 0);
      session.connection.port.postMessage({ completed: id });
    }
    session.pending.clear();
    wake(session.connection);
    for (const handle of session.handles) this.backend.release(handle);
    session.handles.clear(); session.preopens.clear(); session.transient.clear(); session.references.clear(); session.responses.clear();
    session.connection.port.close();
    this.sessions.delete(session);
  }
  resources() {
    // retained counts actual backend pins, including transient path capabilities, not just opens.
    return {
      clients: this.sessions.size,
      retained: Array.from(this.sessions, session => session.handles.size).reduce((a, b) => a + b, 0),
      transient: Array.from(this.sessions, session => session.transient.size).reduce((a, b) => a + b, 0),
      responses: Array.from(this.sessions, session => session.responses.size).reduce((a, b) => a + b, 0),
    };
  }
  dispose(): void { for (const session of this.sessions) this.close(session); }
}
/** Installs the service in a browser/Bun worker without importing any app code. */
export function installFilesystemWorker(scope: { onmessage: ((event: MessageEvent<any>) => void) | null; }): void {
  // The backend is deliberately selected at the worker entrypoint, not by guest requests.
  const service = new FilesystemService(new MemoryBackend());
  scope.onmessage = ({ data }) => {
    if (data.connect) service.connect(data.connect);
    else if (data.sweep) service.sweep();
  };
}
