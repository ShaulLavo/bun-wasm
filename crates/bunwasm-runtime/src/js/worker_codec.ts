(function (internal: BunWasm.Internal) {
  "use strict";
  type Graph = BunWasm.WorkerGraph;
  type Node = BunWasm.WorkerNode;
  const tag = (value: object) => Object.prototype.toString.call(value).slice(8, -1);
  const errors: Record<string, ErrorConstructor> = { Error, TypeError, RangeError, SyntaxError, ReferenceError, URIError, EvalError };
  const views: Record<string, (buffer: ArrayBuffer, offset: number, bytes: number) => ArrayBufferView> = {
    Int8Array: (b, o, n) => new Int8Array(b, o, n), Uint8Array: (b, o, n) => new Uint8Array(b, o, n),
    Uint8ClampedArray: (b, o, n) => new Uint8ClampedArray(b, o, n),
    Int16Array: (b, o, n) => new Int16Array(b, o, n / 2), Uint16Array: (b, o, n) => new Uint16Array(b, o, n / 2),
    Int32Array: (b, o, n) => new Int32Array(b, o, n / 4), Uint32Array: (b, o, n) => new Uint32Array(b, o, n / 4),
    Float32Array: (b, o, n) => new Float32Array(b, o, n / 4), Float64Array: (b, o, n) => new Float64Array(b, o, n / 8),
    BigInt64Array: (b, o, n) => new BigInt64Array(b, o, n / 8), BigUint64Array: (b, o, n) => new BigUint64Array(b, o, n / 8),
    DataView: (b, o, n) => new DataView(b, o, n),
  };
  function cloneError(message = "The object cannot be cloned") { return new DOMException(message, "DataCloneError"); }
  function create(hooks: BunWasm.WorkerCodecHooks): BunWasm.WorkerCodec {
    function prepare(value: unknown, transfer?: unknown, forbidden: readonly string[] = []) {
      const list = transfer == null ? [] : transfer;
      if (typeof list !== "object" || !(Symbol.iterator in list)) throw new TypeError("transferList must be iterable");
      const items = Array.from(list as Iterable<unknown>);
      const seen = new Set<unknown>();
      const buffers: ArrayBuffer[] = [];
      const ports = new Map<unknown, BunWasm.PortTransfer>();
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
          return ["port", { id: snapshot.id, peer: snapshot.peer, version: snapshot.version, sent: snapshot.sent,
            received: snapshot.received, pending: snapshot.pending, closing: snapshot.closing, closed: snapshot.closed }, queue];
        }
        if (internal.isProxy?.(object)) throw cloneError();
        if (object instanceof Blob) return ["blob", internal.native.base64Encode(object._bytes(), false), object.type];
        if (object instanceof ArrayBuffer) return ["buffer", internal.native.base64Encode(new Uint8Array(object), false), object.resizable ? object.maxByteLength : 0];
        if (ArrayBuffer.isView(object) && hooks.buffer?.isBuffer(object)) return ["node-buffer", internal.native.base64Encode(new Uint8Array(object.buffer, object.byteOffset, object.byteLength), false)];
        if (ArrayBuffer.isView(object)) return ["view", tag(object), visit(object.buffer, implicit), object.byteOffset, object.byteLength];
        if (object instanceof Date) return ["date", String(object.getTime())];
        if (object instanceof RegExp) return ["regexp", object.source, object.flags];
        if (object instanceof Map) return ["map", Array.from(object, ([key, value]): [number, number] => [visit(key, implicit), visit(value, implicit)])];
        if (object instanceof Set) return ["set", Array.from(object, value => visit(value, implicit))];
        if (object instanceof Error) return ["error", object.name, object.message, object.stack || "", visit("cause" in object ? object.cause : undefined, implicit)];
        if (Array.isArray(object)) return ["array", object.length, entries(object, implicit)];
        if (object instanceof Number || object instanceof String || object instanceof Boolean || tag(object) === "BigInt") return ["boxed", visit(object.valueOf(), implicit)];
        if (object instanceof EventTarget || ["SharedArrayBuffer", "Promise", "WeakMap", "WeakSet", "WeakRef", "FinalizationRegistry", "Symbol", "WebAssembly.Module", "WebAssembly.Memory"].includes(tag(object))) throw cloneError();
        return ["object", entries(object, implicit)];
      }
      function visit(value: unknown, implicit = false): number {
        if (typeof value === "function" || typeof value === "symbol") throw cloneError();
        if (value !== null && typeof value === "object") {
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
      const root = visit(value);
      for (const plan of ports.values()) plan.validate();
      for (const buffer of buffers) new Uint8Array(buffer);
      return { graph: { root, nodes }, commit() {
        for (const plan of ports.values()) plan.validate();
        for (const buffer of buffers) if (internal.isWasmMemoryBuffer?.(buffer)) throw cloneError("WebAssembly memory is not transferable");
        try { internal.native.transferArrayBuffers(buffers); }
        catch { throw cloneError("ArrayBuffer is not detachable"); }
        for (const plan of ports.values()) plan.commit();
      } };
    }

    function decode(value: unknown) {
      const graph = validateGraph(value, 0, Boolean(hooks.buffer));
      const memory = new Map<number, unknown>();
      const restored: unknown[] = [];
      function properties(target: object, entries: [string, number][]) {
        for (const [key, ref] of entries) Object.defineProperty(target, key, { value: read(ref), writable: true, configurable: true, enumerable: true });
        return target;
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
          case "node-buffer": {
            if (!hooks.buffer) throw cloneError("Node Buffer decoding is unavailable");
            const bytes = internal.native.base64Decode(node[1]);
            if (internal.native.base64Encode(bytes, false) !== node[1]) throw cloneError("Invalid Node Buffer bytes");
            result = hooks.buffer.from(bytes); break;
          }
          case "view": {
            const buffer = read(node[2]);
            if (!(buffer instanceof ArrayBuffer) || !views[node[1]]) throw cloneError("Invalid typed array");
            result = views[node[1]](buffer, node[3], node[4]); break;
          }
          case "array": { const array = new Array(node[1]); memory.set(index, array); return properties(array, node[2]); }
          case "object": { const object = {}; memory.set(index, object); return properties(object, node[1]); }
          case "map": { const map = new Map(); memory.set(index, map); for (const [key, val] of node[1]) map.set(read(key), read(val)); return map; }
          case "set": { const set = new Set(); memory.set(index, set); for (const ref of node[1]) set.add(read(ref)); return set; }
          case "error": {
            const error = new (errors[node[1]] || Error)(node[2]); memory.set(index, error);
            if (node[3]) Object.defineProperty(error, "stack", { value: node[3], writable: true, configurable: true });
            const cause = read(node[4]); if (cause !== undefined) Object.defineProperty(error, "cause", { value: cause, writable: true, configurable: true });
            return error;
          }
          case "boxed": result = Object(read(node[1])); break;
          case "port": {
            const queue: unknown[] = [];
            const port = hooks.restore({ ...node[1], queue });
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
    return { encode, decode, prepare };
  }

  function validateGraph(value: unknown, depth = 0, nodeBuffer = false): Graph {
    if (depth > 256) throw cloneError("Worker port nesting exceeds 256 levels");
    if (!value || typeof value !== "object" || !("root" in value) || !("nodes" in value) || !Array.isArray(value.nodes)) throw cloneError("Invalid worker message");
    const nodes: unknown[] = value.nodes;
    const ref = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0 && value < nodes.length;
    const strings = (values: unknown[]) => values.every(value => typeof value === "string");
    const pairs = (values: unknown, stringKeys: boolean) => Array.isArray(values) && values.every(pair => Array.isArray(pair) && pair.length === 2 && (stringKeys ? typeof pair[0] === "string" : ref(pair[0])) && ref(pair[1]));
    function valid(node: unknown): boolean {
      if (!Array.isArray(node)) return false;
      switch (node[0]) {
        case "undefined": case "null": return node.length === 1;
        case "string": case "number": case "bigint": case "date": return node.length === 2 && typeof node[1] === "string";
        case "boolean": return node.length === 2 && typeof node[1] === "boolean";
        case "object": return pairs(node[1], true);
        case "array": return Number.isSafeInteger(node[1]) && node[1] >= 0 && node[1] <= 0xffffffff && pairs(node[2], true);
        case "map": return pairs(node[1], false);
        case "set": return Array.isArray(node[1]) && node[1].every(ref);
        case "blob": case "regexp": return strings(node.slice(1)) && node.length === 3;
        case "buffer": return typeof node[1] === "string" && Number.isSafeInteger(node[2]) && node[2] >= 0;
        case "node-buffer": return nodeBuffer && node.length === 2 && typeof node[1] === "string" && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/][AQgw]==|[A-Za-z0-9+/]{2}[AEIMQUYcgkosw048]=)?$/.test(node[1]);
        case "view": return typeof node[1] === "string" && ref(node[2]) && Number.isInteger(node[3]) && Number.isInteger(node[4]) && node[3] >= 0 && node[4] >= 0;
        case "error": return strings(node.slice(1, 4)) && ref(node[4]);
        case "boxed": return ref(node[1]);
        case "port": return validPort(node[1], depth, nodeBuffer) && ref(node[2]);
        default: return false;
      }
    }
    if (!ref(value.root) || !nodes.every(valid)) throw cloneError("Invalid worker message graph");
    return value as Graph;
  }
  function validPort(value: unknown, depth: number, nodeBuffer: boolean) {
    if (!value || typeof value !== "object") return false;
    return "id" in value && typeof value.id === "string" && "peer" in value && (value.peer === null || typeof value.peer === "string")
      && "version" in value && counter(value.version) && "sent" in value && counter(value.sent)
      && "received" in value && counter(value.received) && "pending" in value && Array.isArray(value.pending) && value.pending.every(packet => validPending(packet, depth, nodeBuffer))
      && "closing" in value && (value.closing === null || counter(value.closing))
      && "closed" in value && typeof value.closed === "boolean";
  }
  function counter(value: unknown) { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
  function validPending(value: unknown, depth: number, nodeBuffer: boolean) {
    if (!Array.isArray(value) || value.length !== 2 || !counter(value[0])) return false;
    validateGraph(value[1], depth + 1, nodeBuffer);
    return true;
  }
  return { create };
})
