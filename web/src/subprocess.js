import { memoryViews } from "./memory-views.js";

// Shared transport for browser and Node workers. No native executables are launched.
const NativeEncoder = TextEncoder;
const NativeDecoder = TextDecoder;
const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);
const nativeClearTimeout = globalThis.clearTimeout.bind(globalThis);
const encode = new NativeEncoder();
const decode = new NativeDecoder();
const AGAIN = -2;
const BADF = -3;
const PIPE_SIZE = 1 << 20;
const SNAPSHOT_SIZE = 8 << 20;
const FIRST_HANDLE = 0x60000000;
export const MAX_CHILDREN = 4;

export function createProcessBudget() {
  return new SharedArrayBuffer(8 + MAX_CHILDREN * 4);
}

function wake(budget) {
  const cells = new Int32Array(budget);
  Atomics.add(cells, 1, 1);
  Atomics.notify(cells, 1);
}

export class SharedPipe {
  constructor(buffer = new SharedArrayBuffer(16 + PIPE_SIZE), budget) {
    this.buffer = buffer;
    this.cells = new Int32Array(buffer, 0, 4);
    this.bytes = new Uint8Array(buffer, 16);
    this.budget = budget;
  }
  read(cap = 65536) {
    const read = Atomics.load(this.cells, 0) >>> 0;
    // Observing EOF must also observe every write published before close().
    const closed = Atomics.load(this.cells, 2);
    const written = Atomics.load(this.cells, 1) >>> 0;
    const size = Math.min((written - read) >>> 0, cap);
    if (!size) return closed ? 0 : AGAIN;
    const start = read % PIPE_SIZE;
    const first = Math.min(size, PIPE_SIZE - start);
    const out = new Uint8Array(size);
    out.set(this.bytes.subarray(start, start + first));
    if (first < size) out.set(this.bytes.subarray(0, size - first), first);
    Atomics.store(this.cells, 0, (read + size) | 0);
    Atomics.add(this.cells, 3, 1);
    Atomics.notify(this.cells, 3);
    return out;
  }
  write(bytes) {
    if (Atomics.load(this.cells, 2)) return -1;
    const read = Atomics.load(this.cells, 0) >>> 0;
    const written = Atomics.load(this.cells, 1) >>> 0;
    const size = Math.min(PIPE_SIZE - ((written - read) >>> 0), bytes.length);
    if (!size) return bytes.length ? AGAIN : 0;
    const start = written % PIPE_SIZE;
    const first = Math.min(size, PIPE_SIZE - start);
    this.bytes.set(bytes.subarray(0, first), start);
    if (first < size) this.bytes.set(bytes.subarray(first, size), 0);
    Atomics.store(this.cells, 1, (written + size) | 0);
    Atomics.add(this.cells, 3, 1);
    Atomics.notify(this.cells, 3);
    wake(this.budget);
    return size;
  }
  writeAll(bytes) {
    let at = 0;
    while (at < bytes.length) {
      const seen = Atomics.load(this.cells, 3);
      const n = this.write(bytes.subarray(at));
      if (n === AGAIN) Atomics.wait(this.cells, 3, seen, 100);
      else if (n < 0) return;
      else at += n;
    }
  }
  readBlocking(cap) {
    for (;;) {
      const seen = Atomics.load(this.cells, 3);
      const value = this.read(cap);
      if (value !== AGAIN) return value;
      Atomics.wait(this.cells, 3, seen, 100);
    }
  }
  close() {
    Atomics.store(this.cells, 2, 1);
    Atomics.add(this.cells, 3, 1);
    Atomics.notify(this.cells, 3);
    wake(this.budget);
  }
}

class FilesystemMailbox {
  constructor(buffer, transport) {
    this.state = new Int32Array(buffer, 0, 1);
    this.bytes = new Uint8Array(buffer, 4);
    this.control = new Int32Array(transport.control, 0, 4);
    this.budget = transport.budget;
  }
  send(snapshot, wait = true) {
    if (!snapshot || snapshot === "[]") return true;
    const bytes = encode.encode(snapshot);
    if (bytes.length > this.bytes.length) throw Object.assign(new Error("Child filesystem changes exceed 8 MiB"), { code: "E2BIG" });
    for (;;) {
      const size = Atomics.load(this.state, 0);
      if (!size) break;
      if (!wait) return false;
      if (Atomics.load(this.control, 0) || Atomics.load(this.control, 3)) return false;
      Atomics.wait(this.state, 0, size, 100);
    }
    if (Atomics.load(this.control, 0) || Atomics.load(this.control, 3)) return false;
    this.bytes.set(bytes);
    Atomics.store(this.state, 0, bytes.length);
    wake(this.budget);
    return true;
  }
  receive() {
    const size = Atomics.load(this.state, 0);
    if (!size) return null;
    const snapshot = decode.decode(this.bytes.slice(0, size));
    Atomics.store(this.state, 0, 0);
    Atomics.notify(this.state, 0);
    return snapshot;
  }
}

export function childTransport(transport) {
  const incoming = transport.filesystem ? new FilesystemMailbox(transport.filesystem.toChild, transport) : null;
  const outgoing = transport.filesystem ? new FilesystemMailbox(transport.filesystem.toParent, transport) : null;
  return {
    stdin: new SharedPipe(transport.pipes[0], transport.budget),
    stdout: new SharedPipe(transport.pipes[1], transport.budget),
    stderr: new SharedPipe(transport.pipes[2], transport.budget),
    receiveFilesystem: () => incoming?.receive() ?? null,
    sendFilesystem: (snapshot) => outgoing?.send(snapshot) ?? true,
    finish(code, snapshot) {
      const cells = new Int32Array(transport.control, 0, 4);
      if (Atomics.load(cells, 0)) return;
      let result = snapshot ? encode.encode(snapshot) : new Uint8Array();
      if (result.length > SNAPSHOT_SIZE) {
        result = new Uint8Array();
        code = 1;
        new SharedPipe(transport.pipes[2], transport.budget).writeAll(encode.encode("bun-wasm: child filesystem changes exceed 8 MiB\n"));
      }
      new Uint8Array(transport.control, 16).set(result);
      Atomics.store(cells, 2, result.length);
      Atomics.store(cells, 1, code);
      for (const [fd, pipe] of transport.pipes.entries()) {
        if (fd === 0 && transport.inheritedStdin) continue;
        new SharedPipe(pipe, transport.budget).close();
      }
      Atomics.store(cells, 0, 1);
      Atomics.notify(cells, 0);
      wake(transport.budget);
    },
  };
}

export class SubprocessHost {
  constructor(options) {
    this.options = options;
    this.budget = options.budget || createProcessBudget();
    this.children = new Map();
    this.handles = new Map();
    this.nextHandle = FIRST_HANDLE;
    this.lastError = null;
    this.timer = null;
    this.notify = () => {};
    this.memory = null;
    this.stdin = options.stdin ? new SharedPipe(options.stdin, this.budget) : null;
    this.stdinWaiting = false;
  }
  attach(memory) { this.memory = memoryViews(memory); }
  fail(message, code) {
    this.lastError = JSON.stringify({ name: "Error", message, code });
    return -1;
  }
  parentActive(cells) {
    const slot = this.options.slot;
    if (slot === undefined) return true;
    const state = Atomics.load(cells, slot + 2);
    return state > 0 && Math.floor(state / 8) === this.options.token;
  }
  reserve() {
    const cells = new Int32Array(this.budget);
    if (!this.parentActive(cells)) return null;
    const token = (Atomics.add(cells, 0, 1) >>> 0) % 0x0fffffff + 1;
    const parent = this.options.slot;
    // One atomic word carries both generation and parent link; checking a separate token races reuse.
    const state = token * 8 + (parent === undefined ? 1 : parent + 2);
    for (let slot = 0; slot < MAX_CHILDREN; slot++) {
      if (Atomics.compareExchange(cells, slot + 2, 0, state) !== 0) continue;
      if (this.parentActive(cells)) return { slot, token };
      this.releaseSlot(slot, token);
      return null;
    }
    return null;
  }
  releaseSlot(slot, token) {
    const cells = new Int32Array(this.budget);
    const state = Atomics.load(cells, slot + 2);
    if (state <= 0 || Math.floor(state / 8) !== token) return;
    if (Atomics.compareExchange(cells, slot + 2, state, -token) !== state) return;
    for (let child = 0; child < MAX_CHILDREN; child++) {
      const owned = Atomics.load(cells, child + 2);
      if (owned > 0 && owned % 8 === slot + 2) this.releaseSlot(child, Math.floor(owned / 8));
    }
    Atomics.compareExchange(cells, slot + 2, -token, 0);
  }
  spawn(text) {
    let meta;
    try { meta = JSON.parse(text); } catch { return this.fail("spawn: invalid metadata", "EINVAL"); }
    if (!meta || typeof meta !== "object") return this.fail("spawn: invalid metadata", "EINVAL");
    if (!Array.isArray(meta.argv) || !meta.argv.length || meta.argv.some((v) => typeof v !== "string")) return this.fail("spawn: invalid argv", "EINVAL");
    if (!["bun", "/bun"].includes(meta.argv[0])) return this.fail(`spawn ${meta.argv[0]}: not supported in bun-wasm`, "ENOENT");
    if (meta.cwd !== undefined && typeof meta.cwd !== "string") return this.fail("spawn: invalid cwd", "EINVAL");
    if (meta.env !== undefined && (!meta.env || typeof meta.env !== "object" || Array.isArray(meta.env) || Object.values(meta.env).some((v) => typeof v !== "string"))) return this.fail("spawn: invalid env", "EINVAL");
    const modes = [meta.stdin || "pipe", meta.stdout || "pipe", meta.stderr || "pipe"];
    if (modes.some((mode) => !["pipe", "inherit", "ignore"].includes(mode))) return this.fail("spawn: invalid stdio", "EINVAL");
    const reservation = this.reserve();
    if (!reservation) return this.fail("spawn: at most four bun-wasm child instances may run", "EAGAIN");
    const { slot, token } = reservation;
    const buffers = modes.map(() => new SharedArrayBuffer(16 + PIPE_SIZE));
    const inheritedStdin = modes[0] === "inherit" && Boolean(this.options.stdin);
    if (inheritedStdin) buffers[0] = this.options.stdin;
    const filesystem = this.options.filesystem?.() ?? null;
    const transport = { budget: this.budget, slot, token, inheritedStdin, pipes: buffers, control: new SharedArrayBuffer(16 + SNAPSHOT_SIZE),
      filesystem: filesystem ? { toChild: new SharedArrayBuffer(4 + SNAPSHOT_SIZE), toParent: new SharedArrayBuffer(4 + SNAPSHOT_SIZE) } : null };
    const id = this.nextHandle++;
    const pipes = transport.pipes.map((buffer) => new SharedPipe(buffer, this.budget));
    const handles = pipes.map((pipe, fd) => {
      if (modes[fd] !== "pipe") return 0;
      const handle = this.nextHandle++;
      this.handles.set(handle, { pipe, fd, child: id });
      return handle;
    });
    const child = { transport, pipes, handles, modes, worker: null, ended: false, filesystem,
      outgoing: filesystem ? new FilesystemMailbox(transport.filesystem.toChild, transport) : null,
      incoming: filesystem ? new FilesystemMailbox(transport.filesystem.toParent, transport) : null };
    this.children.set(id, child);
    if (modes[0] !== "pipe" && !inheritedStdin) pipes[0].close();
    try { child.worker = this.options.launch(meta, transport, (error) => this.workerError(id, error)); }
    catch (error) {
      this.kill(id, 9);
      this.release(id);
      return this.fail(String(error), error?.code || "EIO");
    }
    this.watch();
    return id;
  }
  workerError(id, error) {
    const child = this.children.get(id);
    if (!child || child.ended) return;
    child.pipes[2].write(encode.encode(`bun-wasm: ${String(error)}\n`));
    childTransport(child.transport).finish(1);
    this.notify();
  }
  pipe(id, fd) {
    const child = this.children.get(id);
    return child && fd >= 0 && fd <= 2 ? child.handles[fd] : BADF;
  }
  read(handle, cap) {
    if (handle === 0) {
      const value = this.stdin ? this.stdin.read(cap) : -4;
      this.options.syncFilesystem?.();
      this.stdinWaiting = value === AGAIN;
      if (this.stdinWaiting) this.watch();
      return value;
    }
    const h = this.handles.get(handle);
    if (!h || h.fd === 0) return BADF;
    const value = h.pipe.read(cap);
    this.synchronize(this.children.get(h.child));
    return value;
  }
  write(handle, bytes) {
    const h = this.handles.get(handle);
    if (!h || h.fd !== 0) return BADF;
    const child = this.children.get(h.child);
    if (!this.publishFilesystem(child)) {
      const control = new Int32Array(child.transport.control, 0, 4);
      return Atomics.load(control, 0) || Atomics.load(control, 3) ? -1 : AGAIN;
    }
    return h.pipe.write(bytes);
  }
  close(handle) {
    if (this.children.has(handle)) {
      this.kill(handle, 9);
      this.release(handle);
      return 0;
    }
    const h = this.handles.get(handle);
    if (!h) return BADF;
    h.pipe.close();
    this.handles.delete(handle);
    return 0;
  }
  wait(id) {
    const child = this.children.get(id);
    if (!child) return BADF;
    this.drainInherited(child);
    const cells = new Int32Array(child.transport.control, 0, 4);
    const done = Atomics.load(cells, 0);
    this.synchronize(child);
    if (!done) {
      this.publishFilesystem(child);
      return AGAIN;
    }
    if (!child.ended) this.reap(child, cells);
    return Atomics.load(cells, 1);
  }
  reap(child, cells) {
    child.ended = true;
    this.releaseSlot(child.transport.slot, child.transport.token);
    const size = Atomics.load(cells, 2);
    if (size && child.filesystem) child.filesystem.merge(decode.decode(new Uint8Array(child.transport.control, 16, size).slice()));
    child.worker?.terminate();
  }
  publishFilesystem(child) {
    const snapshot = child.filesystem?.capture();
    if (!snapshot) return true;
    if (!child.outgoing.send(snapshot, false)) return false;
    child.filesystem.commit(snapshot);
    return true;
  }
  synchronize(child) {
    const snapshot = child?.incoming?.receive();
    if (snapshot) child.filesystem.merge(snapshot);
  }
  release(id) {
    const child = this.children.get(id);
    if (!child) return;
    for (const handle of child.handles) this.handles.delete(handle);
    this.children.delete(id);
  }
  kill(id, signal = 15) {
    const child = this.children.get(id);
    if (!child) return BADF;
    if (!Number.isInteger(signal) || signal < 0 || signal > 64) return this.fail("kill: invalid signal", "EINVAL");
    if (this.wait(id) !== AGAIN || signal === 0) return 0;
    child.worker?.terminate();
    childTransport(child.transport).finish(128 + signal);
    this.wait(id);
    return 0;
  }
  drainInherited(child) {
    for (const fd of [1, 2]) {
      if (child.modes[fd] === "pipe") continue;
      this.drainPipe(child, fd);
    }
  }
  drainPipe(child, fd) {
    for (;;) {
      const bytes = child.pipes[fd].read();
      this.synchronize(child);
      if (typeof bytes === "number") return;
      if (child.modes[fd] === "inherit") this.options.output(fd, bytes);
    }
  }
  poll(timeout = 0) {
    this.options.syncFilesystem?.();
    for (const id of this.children.keys()) this.wait(id);
    if (!timeout) return 0;
    const cells = new Int32Array(this.budget);
    const seen = Atomics.load(cells, 1);
    Atomics.wait(cells, 1, seen, timeout < 0 ? 4 : Math.min(timeout, 4));
    for (const id of this.children.keys()) this.wait(id);
    return Atomics.load(cells, 1) !== seen ? 1 : 0;
  }
  watch() {
    if (this.timer !== null) return;
    this.timer = nativeSetTimeout(() => {
      this.timer = null;
      this.poll();
      this.notify();
      if (this.stdinWaiting || Array.from(this.children.values()).some((child) => !child.ended)) this.watch();
    }, 4);
  }
  dispose() {
    this.stdinWaiting = false;
    if (this.timer !== null) nativeClearTimeout(this.timer);
    this.timer = null;
    for (const id of this.children.keys()) {
      this.kill(id, 9);
      this.release(id);
    }
  }
  owns(handle) { return handle >= FIRST_HANDLE; }
  engineNet(net) {
    const fallback = Object.fromEntries(Object.entries(net?.natives || {}).map(([name, fn]) => [name, (...args) => {
      if (name !== "hostError") this.lastError = null;
      return fn(...args);
    }]));
    const route = (name, operation) => (handle, ...args) => this.owns(handle) || name === "hostRead" && handle === 0 ? operation(handle, ...args) : (fallback[name]?.(handle, ...args) ?? BADF);
    return {
      natives: {
        ...fallback,
        hostPoll: (timeout) => this.poll(timeout),
        hostSpawn: (meta) => this.spawn(meta),
        hostChildWait: (id) => this.wait(id),
        hostChildPipe: (id, fd) => this.pipe(id, fd),
        hostChildKill: (id, signal) => this.kill(id, signal),
        hostRead: route("hostRead", (id, cap) => this.read(id, cap)),
        hostWrite: route("hostWrite", (id, bytes) => this.write(id, bytes)),
        hostClose: route("hostClose", (id) => this.close(id)),
        hostError: (id) => id === 0 && this.lastError ? this.lastError : (fallback.hostError?.(id) ?? this.lastError ?? BADF),
      },
      caps: { ...net?.caps, spawn: true, child_wait: true, child_pipe: true, child_kill: true, read: true, write: true, close: true, error: true },
      onNews: (cb) => { this.notify = cb; net?.onNews(cb); },
    };
  }
  slots(network = {}) {
    const net = Object.fromEntries(Object.entries(network).map(([name, fn]) => [name, (...args) => {
      if (name !== "error" && name !== "poll") this.lastError = null;
      return fn(...args);
    }]));
    const bytes = (ptr, len) => this.memory.range(ptr >>> 0, len);
    const read = (id, ptr, cap) => {
      const value = this.read(id, cap);
      if (typeof value === "number") return value;
      bytes(ptr, value.length).set(value);
      return value.length;
    };
    const error = (ptr, cap) => {
      const value = encode.encode(this.lastError || '{"message":"no error"}');
      if (value.length <= cap) bytes(ptr, value.length).set(value);
      return value.length;
    };
    return {
      ...net,
      spawn: (ptr, len) => this.spawn(decode.decode(bytes(ptr, len).slice())),
      child_wait: (id) => this.wait(id),
      child_pipe: (id, fd) => this.pipe(id, fd),
      child_kill: (id, signal) => this.kill(id, signal),
      read: (id, ptr, cap) => id === 0 || this.owns(id) ? read(id, ptr, cap) : (net.read?.(id, ptr, cap) ?? BADF),
      write: (id, ptr, len) => this.owns(id) ? this.write(id, bytes(ptr, len)) : (net.write?.(id, ptr, len) ?? BADF),
      close: (id) => this.owns(id) ? this.close(id) : (net.close?.(id) ?? BADF),
      error: (id, ptr, cap) => id === 0 && this.lastError ? error(ptr, cap) : (net.error?.(id, ptr, cap) ?? BADF),
      poll: (timeout) => { const news = net.poll?.(0) || 0; return this.poll(news ? 0 : timeout) || news; },
    };
  }
}
