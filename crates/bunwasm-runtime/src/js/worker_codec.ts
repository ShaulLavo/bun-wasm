(function (internal: BunWasm.Internal) {
  "use strict";
  type Graph = BunWasm.WorkerGraph;
  type Node = BunWasm.WorkerNode;
  type BufferNode = Extract<Node, ["node-buffer", number, number, number]>;
  const bufferByteLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")!.get!;
  const sharedByteLength = typeof SharedArrayBuffer === "function" ? Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, "byteLength")!.get! : null;
  const tag = (value: object) => Object.prototype.toString.call(value).slice(8, -1);
  const errors: Record<string, ErrorConstructor> = { Error, TypeError, RangeError, SyntaxError, ReferenceError, URIError, EvalError };
  const views: Record<string, (buffer: ArrayBufferLike, offset: number, bytes: number) => ArrayBufferView> = {
    Int8Array: (b, o, n) => new Int8Array(b, o, n), Uint8Array: (b, o, n) => new Uint8Array(b, o, n),
    Uint8ClampedArray: (b, o, n) => new Uint8ClampedArray(b, o, n),
    Int16Array: (b, o, n) => new Int16Array(b, o, n / 2), Uint16Array: (b, o, n) => new Uint16Array(b, o, n / 2),
    Int32Array: (b, o, n) => new Int32Array(b, o, n / 4), Uint32Array: (b, o, n) => new Uint32Array(b, o, n / 4),
    Float32Array: (b, o, n) => new Float32Array(b, o, n / 4), Float64Array: (b, o, n) => new Float64Array(b, o, n / 8),
    BigInt64Array: (b, o, n) => new BigInt64Array(b, o, n / 8), BigUint64Array: (b, o, n) => new BigUint64Array(b, o, n / 8),
    DataView: (b, o, n) => new DataView(b, o, n),
  };
  function isArrayBuffer(value: unknown): value is ArrayBuffer {
    try { bufferByteLength.call(value); return true; }
    catch { return false; }
  }
  function isSharedBuffer(value: unknown): value is SharedArrayBuffer {
    if (!sharedByteLength) return false;
    try { sharedByteLength.call(value); return true; }
    catch { return false; }
  }
  function encodeBuffer(buffer: ArrayBuffer): Node {
    return ["buffer", internal.native.base64Encode(new Uint8Array(buffer), false), buffer.resizable ? buffer.maxByteLength : 0];
  }
  function cloneError(message = "The object cannot be cloned") { return new DOMException(message, "DataCloneError"); }
  function create(hooks: BunWasm.WorkerCodecHooks): BunWasm.WorkerCodec {
    const sharedObjects = hooks.sharedObjects;
    function prepare(value: unknown, transfer?: unknown, forbidden: readonly string[] = []) {
      const processEnv = typeof internal.require === "function" ? internal.require("process").env : undefined;
      const list = transfer == null ? [] : transfer;
      if (typeof list !== "object" || !(Symbol.iterator in list)) throw new TypeError("transferList must be iterable");
      const items = Array.from(list as Iterable<unknown>);
      const seen = new Set<unknown>();
      const buffers: ArrayBuffer[] = [];
      const ports = new Map<unknown, BunWasm.PortTransfer>();
      let publication: BunWasm.SharedPublication | undefined;
      function sharedNode(buffer: SharedArrayBuffer): Node {
        if (!sharedObjects) throw cloneError();
        publication ??= sharedObjects.begin();
        const reference = publication.reference(buffer);
        return ["shared", reference.id, reference.byteLength];
      }
      function prepare(item: unknown) {
        if (internal.isMarkedAsUntransferable?.(item)) throw cloneError("Object is not transferable");
        if (!hooks.isPort(item)) throw cloneError("Invalid transferable object");
        if (ports.has(item)) return;
        const plan = hooks.prepare(item);
        if (forbidden.includes(plan.snapshot.id)) throw cloneError("Transfer list contains the source or destination port");
        ports.set(item, plan);
      }
      for (const item of items) {
        if (seen.has(item)) throw cloneError("Transfer list contains a duplicate");
        seen.add(item);
        if (internal.isMarkedAsUntransferable?.(item)) throw cloneError("Object is not transferable");
        if (item instanceof ArrayBuffer) { new Uint8Array(item); buffers.push(item); continue; }
        prepare(item);
      }
      const nodes: Node[] = [];
      const memory = new Map<object, number>();
      const bufferViews = new Map<ArrayBuffer, [BufferNode, ...BufferNode[]]>();
      const fullBuffers = new Set<ArrayBuffer>();
      function bufferView(view: ArrayBufferView, implicit: boolean): BufferNode {
        if (!isArrayBuffer(view.buffer)) throw cloneError();
        const node: BufferNode = ["node-buffer", 0, view.byteOffset, view.byteLength];
        const group = bufferViews.get(view.buffer);
        if (group) group.push(node);
        else bufferViews.set(view.buffer, [node]);
        node[1] = visit(view.buffer, implicit, true);
        return node;
      }
      function finishBufferViews(buffer: ArrayBuffer, group: [BufferNode, ...BufferNode[]]) {
        const index = group[0][1];
        if (fullBuffers.has(buffer)) { nodes[index] = encodeBuffer(buffer); return; }
        let start = group[0][2];
        let end = start + group[0][3];
        for (const node of group) {
          start = Math.min(start, node[2]);
          end = Math.max(end, node[2] + node[3]);
        }
        const bytes = new Uint8Array(end - start);
        for (const node of group) {
          bytes.set(new Uint8Array(buffer, node[2], node[3]), node[2] - start);
          node[2] -= start;
        }
        nodes[index] = ["buffer", internal.native.base64Encode(bytes, false), 0];
      }
      function entries(object: object, implicit: boolean): [string, number][] {
        return Object.keys(object).map(key => [key, visit(Reflect.get(object, key), implicit)]);
      }
      function objectNode(object: object, implicit: boolean): Node {
        if (hooks.isPort(object)) {
          if (implicit) prepare(object);
          const plan = ports.get(object);
          if (!plan) throw cloneError("Object that needs transfer was found in message but not listed in transferList");
          const snapshot = plan.snapshot;
          const queue = visit(snapshot.queue, true);
          const meta = { id: snapshot.id, peer: snapshot.peer, version: snapshot.version, sent: snapshot.sent,
            received: snapshot.received, pending: snapshot.pending, closing: snapshot.closing, closed: snapshot.closed };
          if (!snapshot.lane) return ["port", meta, queue];
          return ["port", { ...meta, side: snapshot.lane.side }, queue, visit(snapshot.lane.buffer, true)];
        }
        if (object === processEnv) return ["object", entries(object, implicit)];
        if (internal.isProxy?.(object)) throw cloneError();
        if (isSharedBuffer(object)) return sharedNode(object);
        if (object instanceof Blob) return ["blob", internal.native.base64Encode(object._bytes(), false), object.type];
        if (isArrayBuffer(object)) return bufferViews.has(object) ? ["buffer", "", 0] : encodeBuffer(object);
        if (ArrayBuffer.isView(object) && hooks.buffer?.isBuffer(object)) return bufferView(object, implicit);
        if (ArrayBuffer.isView(object)) return ["view", tag(object), visit(object.buffer, implicit), object.byteOffset, object.byteLength];
        if (object instanceof Date) return ["date", String(object.getTime())];
        if (object instanceof RegExp) return ["regexp", object.source, object.flags];
        if (object instanceof Map) return ["map", Array.from(object, ([key, value]): [number, number] => [visit(key, implicit), visit(value, implicit)])];
        if (object instanceof Set) return ["set", Array.from(object, value => visit(value, implicit))];
        if (object instanceof Error) {
          const name = object.name;
          const message = `${object.message}`;
          const stack = object.stack;
          return ["error", typeof name === "string" ? name : "Error", message, typeof stack === "string" ? stack : null,
            visit("cause" in object ? object.cause : undefined, implicit)];
        }
        if (Array.isArray(object)) return ["array", object.length, entries(object, implicit)];
        if (object instanceof Number || object instanceof String || object instanceof Boolean || tag(object) === "BigInt") return ["boxed", visit(object.valueOf(), implicit)];
        if (object instanceof EventTarget || ["SharedArrayBuffer", "Promise", "WeakMap", "WeakSet", "WeakRef", "FinalizationRegistry", "Symbol", "WebAssembly.Module", "WebAssembly.Memory"].includes(tag(object))) throw cloneError();
        return ["object", entries(object, implicit)];
      }
      function visit(value: unknown, implicit = false, bufferView = false): number {
        if (typeof value === "function" || typeof value === "symbol") throw cloneError();
        if (value !== null && typeof value === "object") {
          if (hooks.buffer && !bufferView && isArrayBuffer(value)) fullBuffers.add(value);
          const known = memory.get(value);
          if (known !== undefined) return known;
        }
        const index = nodes.length;
        nodes.push(["undefined"]);
        if (value !== null && typeof value === "object") memory.set(value, index);
        let node: Node;
        switch (typeof value) {
          case "undefined": node = ["undefined"]; break;
          case "string": node = ["string", value]; break;
          case "number": node = ["number", Object.is(value, -0) ? "-0" : String(value)]; break;
          case "boolean": node = ["boolean", value]; break;
          case "bigint": node = ["bigint", String(value)]; break;
          case "object": node = value === null ? ["null"] : objectNode(value, implicit); break;
          default: throw cloneError();
        }
        nodes[index] = node;
        return index;
      }
      let graph: Graph;
      try {
        const root = visit(value);
        for (const [buffer, group] of bufferViews) finishBufferViews(buffer, group);
        for (const plan of ports.values()) plan.validate();
        for (const buffer of buffers) new Uint8Array(buffer);
        graph = { root, nodes };
      } catch (error) { publication?.abort(); throw error; }
      let phase: "prepared" | "committed" | "aborted" = "prepared";
      function abort() {
        if (phase === "aborted") return;
        publication?.abort(); phase = "aborted";
      }
      function commit(deliver?: () => void, toward?: string) {
        if (phase !== "prepared") throw cloneError("Worker transfer is no longer prepared");
        try {
          validateTransfers();
          publication?.publish();
          const stage = () => { for (const plan of ports.values()) plan.publish?.(toward); deliver?.(); };
          const finish = () => {
            const plans = Array.from(ports.values());
            for (const plan of plans) plan.beforeCommit?.();
            validateTransfers(); detachBuffers();
            for (let index = 0; index < plans.length; index++) plans[index].commit();
          };
          const routes = sharedObjects?.routes;
          if (routes?.enabled) routes.transaction(stage, finish);
          else { stage(); finish(); }
          phase = "committed";
        } catch (error) { abort(); throw error; }
      }
      function validateTransfers() {
        for (const plan of ports.values()) plan.validate();
        for (const buffer of buffers) {
          new Uint8Array(buffer);
          if (internal.isWasmMemoryBuffer?.(buffer)) throw cloneError("WebAssembly memory is not transferable");
        }
      }
      function detachBuffers() {
        try { internal.native.transferArrayBuffers(buffers); }
        catch { throw cloneError("ArrayBuffer is not detachable"); }
      }
      return { graph, commit, abort };
    }

    function decode(value: unknown) {
      const graph = validateGraph(value, 0, Boolean(hooks.buffer), Boolean(sharedObjects));
      for (const reference of sharedReferences(graph)) sharedObjects!.read(reference);
      const memory = new Map<number, unknown>();
      const restored: unknown[] = [];
      function properties(target: object, entries: [string, number][]) {
        for (const [key, ref] of entries) Object.defineProperty(target, key, { value: read(ref), writable: true, configurable: true, enumerable: true });
        return target;
      }
      function readNodeBuffer(node: BufferNode) {
        const adapter = hooks.buffer;
        if (!adapter) throw cloneError("Node Buffer decoding is unavailable");
        const buffer = read(node[1]);
        if (!(buffer instanceof ArrayBuffer)) throw cloneError("Invalid Node Buffer backing");
        return adapter.from(buffer, node[2], node[3]);
      }
      function readView(node: Extract<Node, ["view", string, number, number, number]>) {
        const buffer = read(node[2]);
        if (!isArrayBuffer(buffer) && !isSharedBuffer(buffer)) throw cloneError("Invalid typed array backing");
        return views[node[1]](buffer, node[3], node[4]);
      }
      function read(index: number): unknown {
        if (memory.has(index)) return memory.get(index);
        const node = graph.nodes[index];
        let result: unknown;
        switch (node[0]) {
          case "undefined": return undefined;
          case "null": return null;
          case "string": case "boolean": return node[1];
          case "number": return Number(node[1]);
          case "bigint": return BigInt(node[1]);
          case "blob": result = new Blob([internal.native.base64Decode(node[1])], { type: node[2] }); break;
          case "date": result = new Date(Number(node[1])); break;
          case "regexp": result = new RegExp(node[1], node[2]); break;
          case "buffer": {
            const bytes = internal.native.base64Decode(node[1]);
            const buffer = node[2] ? new ArrayBuffer(bytes.length, { maxByteLength: node[2] }) : new ArrayBuffer(bytes.length);
            new Uint8Array(buffer).set(bytes); result = buffer; break;
          }
          case "shared": {
            const reference = { id: node[1], byteLength: node[2] };
            const buffer = sharedObjects!.read(reference);
            if (!isSharedBuffer(buffer) || sharedByteLength!.call(buffer) !== node[2]) throw cloneError("Invalid shared backing store");
            result = buffer; break;
          }
          case "node-buffer": result = readNodeBuffer(node); break;
          case "view": result = readView(node); break;
          case "array": { const array = new Array(node[1]); memory.set(index, array); return properties(array, node[2]); }
          case "object": { const object = {}; memory.set(index, object); return properties(object, node[1]); }
          case "map": { const map = new Map(); memory.set(index, map); for (const [key, val] of node[1]) map.set(read(key), read(val)); return map; }
          case "set": { const set = new Set(); memory.set(index, set); for (const ref of node[1]) set.add(read(ref)); return set; }
          case "error": {
            const ErrorConstructor = Object.hasOwn(errors, node[1]) ? errors[node[1]] : Error;
            const error = new ErrorConstructor(node[2]); memory.set(index, error);
            Object.defineProperty(error, "stack", { value: node[3] === null ? undefined : node[3], writable: true, configurable: true });
            const cause = read(node[4]); if (cause !== undefined) Object.defineProperty(error, "cause", { value: cause, writable: true, configurable: true });
            return error;
          }
          case "boxed": result = Object(read(node[1])); break;
          case "port": {
            const queue: unknown[] = [];
            const { side, ...meta } = node[1];
            const lane = node.length === 4 && side !== undefined ? { buffer: read(node[3]) as SharedArrayBuffer, side } : null;
            const port = hooks.restore({ ...meta, queue, lane });
            memory.set(index, port); restored.push(port);
            const messages = read(node[2]);
            if (!Array.isArray(messages)) throw cloneError("Invalid port queue");
            for (const message of messages) queue.push(message);
            return port;
          }
          default: { const exhaustive: never = node; throw cloneError(String(exhaustive)); }
        }
        memory.set(index, result);
        return result;
      }
      const result = read(graph.root);
      for (const port of restored) hooks.activate(port);
      return result;
    }
    function encode(value: unknown, transfer?: unknown, forbidden?: readonly string[]) {
      const plan = prepare(value, transfer, forbidden); plan.commit(); return plan.graph;
    }
    function wait(value: unknown, ready: () => void) {
      const graph = validateGraph(value, 0, Boolean(hooks.buffer), Boolean(sharedObjects));
      const references = sharedReferences(graph);
      return references.length ? sharedObjects!.wait(references, ready) : null;
    }
    return { encode, decode, prepare, wait };
  }

  function sharedReferences(graph: Graph): BunWasm.SharedReference[] {
    const references: BunWasm.SharedReference[] = [];
    for (const node of graph.nodes) {
      if (node[0] === "shared") references.push({ id: node[1], byteLength: node[2] });
      if (node[0] !== "port") continue;
      for (const [, pending] of node[1].pending) references.push(...sharedReferences(pending));
    }
    return references;
  }

  function canonicalBase64(value: unknown): value is string {
    return typeof value === "string" && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/][AQgw]==|[A-Za-z0-9+/]{2}[AEIMQUYcgkosw048]=)?$/.test(value);
  }
  function binaryLength(value: string) {
    return value.length / 4 * 3 - (value.endsWith("==") ? 2 : Number(value.endsWith("=")));
  }
  function validBuffer(node: unknown): node is ["buffer", string, number] {
    return Array.isArray(node) && node[0] === "buffer" && node.length === 3 && canonicalBase64(node[1])
      && counter(node[2]) && (node[2] === 0 || node[2] >= binaryLength(node[1]));
  }
  function validShared(node: unknown): node is ["shared", string, number] {
    return Array.isArray(node) && node.length === 3 && node[0] === "shared" && typeof node[1] === "string"
      && /^[\w-]{1,128}\/[\w-]{1,128}$/.test(node[1]) && counter(node[2]);
  }
  function validNumber(value: unknown) {
    return typeof value === "string" && (value === "-0" || String(Number(value)) === value);
  }
  function viewWidth(name: string) {
    if (name === "DataView" || name.endsWith("8Array") || name === "Uint8ClampedArray") return 1;
    if (name.endsWith("16Array")) return 2;
    return name.endsWith("32Array") ? 4 : 8;
  }
  function validateGraph(value: unknown, depth = 0, nodeBuffer = false, shared = false): Graph {
    if (depth > 256) throw cloneError("Worker port nesting exceeds 256 levels");
    if (!value || typeof value !== "object" || !("root" in value) || !("nodes" in value) || !Array.isArray(value.nodes)) throw cloneError("Invalid worker message");
    const nodes: unknown[] = value.nodes;
    const ref = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0 && value < nodes.length;
    const strings = (values: unknown[]) => values.every(value => typeof value === "string");
    const pairs = (values: unknown, stringKeys: boolean) => Array.isArray(values) && values.every(pair => Array.isArray(pair) && pair.length === 2 && (stringKeys ? typeof pair[0] === "string" : ref(pair[0])) && ref(pair[1]));
    function validView(bufferRef: unknown, offset: unknown, length: unknown, width: number) {
      if (!ref(bufferRef) || !counter(offset) || !counter(length)) return false;
      const buffer = nodes[bufferRef];
      const bytes = shared && validShared(buffer) ? buffer[2] : validBuffer(buffer) ? binaryLength(buffer[1]) : -1;
      return bytes >= 0 && offset % width === 0 && length % width === 0 && offset <= bytes && length <= bytes - offset;
    }
    function validNodeBuffer(node: unknown[]) {
      return nodeBuffer && node.length === 4 && ref(node[1]) && validBuffer(nodes[node[1]]) && validView(node[1], node[2], node[3], 1);
    }
    // A port node may name its channel's shared lane and the side of it this end reads.
    function validPortNode(node: unknown[]) {
      if (!validPort(node[1], depth, nodeBuffer, shared) || !ref(node[2])) return false;
      const side = (node[1] as { side?: unknown }).side;
      if (node.length === 3) return side === undefined;
      return node.length === 4 && shared && ref(node[3]) && validShared(nodes[node[3]]) && (side === 0 || side === 1);
    }
    function valid(node: unknown): boolean {
      if (!Array.isArray(node)) return false;
      switch (node[0]) {
        case "undefined": case "null": return node.length === 1;
        case "number": return node.length === 2 && validNumber(node[1]);
        case "string": case "bigint": case "date": return node.length === 2 && typeof node[1] === "string";
        case "boolean": return node.length === 2 && typeof node[1] === "boolean";
        case "object": return pairs(node[1], true);
        case "array": return Number.isSafeInteger(node[1]) && node[1] >= 0 && node[1] <= 0xffffffff && pairs(node[2], true);
        case "map": return pairs(node[1], false);
        case "set": return Array.isArray(node[1]) && node[1].every(ref);
        case "blob": return node.length === 3 && canonicalBase64(node[1]) && typeof node[2] === "string";
        case "regexp": return strings(node.slice(1)) && node.length === 3;
        case "shared": return shared && validShared(node);
        case "buffer": return validBuffer(node);
        case "node-buffer": return validNodeBuffer(node);
        case "view": return node.length === 5 && typeof node[1] === "string" && Object.hasOwn(views, node[1])
          && validView(node[2], node[3], node[4], viewWidth(node[1]));
        case "error": return strings(node.slice(1, 3)) && (node[3] === null || typeof node[3] === "string") && ref(node[4]);
        case "boxed": return ref(node[1]);
        case "port": return validPortNode(node);
        default: return false;
      }
    }
    if (!ref(value.root) || !nodes.every(valid)) throw cloneError("Invalid worker message graph");
    return value as Graph;
  }
  function validPort(value: unknown, depth: number, nodeBuffer: boolean, shared: boolean) {
    if (!value || typeof value !== "object") return false;
    return "id" in value && typeof value.id === "string" && "peer" in value && (value.peer === null || typeof value.peer === "string")
      && "version" in value && counter(value.version) && "sent" in value && counter(value.sent)
      && "received" in value && counter(value.received) && "pending" in value && Array.isArray(value.pending) && value.pending.every(packet => validPending(packet, depth, nodeBuffer, shared))
      && "closing" in value && (value.closing === null || counter(value.closing))
      && "closed" in value && typeof value.closed === "boolean";
  }
  function counter(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
  function validPending(value: unknown, depth: number, nodeBuffer: boolean, shared: boolean) {
    if (!Array.isArray(value) || value.length !== 2 || !counter(value[0])) return false;
    validateGraph(value[1], depth + 1, nodeBuffer, shared);
    return true;
  }
  return { create };
})
