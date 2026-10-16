(function (internal: BunWasm.Internal) {
  "use strict";

  const EventEmitter = internal.require("events");
  const clone = internal.require("structured_clone").structuredClone;
  const untransferable = new WeakSet<object>();
  const environmentData = new Map<unknown, unknown>();
  const channels = new Map<string, Set<BroadcastChannel>>();
  const token = {};
  const messagePayloads = new WeakMap<Event, unknown>();

  function invalidPort() {
    return Object.assign(new TypeError('The "port" argument must be a MessagePort instance'), { code: "ERR_INVALID_ARG_TYPE" });
  }

  function unsupported(operation: string): never {
    throw Object.assign(new Error(`${operation} is not supported in bun-wasm: guest worker execution is not implemented`), {
      code: "ERR_NOT_SUPPORTED_IN_WASM",
    });
  }

  function isObject(value: unknown): value is object {
    return value !== null && (typeof value === "object" || typeof value === "function");
  }

  function markAsUntransferable(value: unknown) {
    if (isObject(value)) untransferable.add(value);
  }

  function isMarkedAsUntransferable(value: unknown) {
    return isObject(value) && untransferable.has(value);
  }
  internal.isMarkedAsUntransferable = isMarkedAsUntransferable;

  function transferOptions(value: unknown) {
    if (value == null) return undefined;
    if (!isObject(value)) throw Object.assign(new TypeError("Optional transferList argument must be an iterable"), { code: "ERR_INVALID_ARG_TYPE" });
    if (Symbol.iterator in value) return { transfer: value };
    return value;
  }

  function messageEvent(data: unknown) {
    const event = new MessageEvent("message", { data });
    messagePayloads.set(event, data);
    return event;
  }

  class MessagePort extends EventTarget {
    #other: MessagePort | null = null;
    #queue: unknown[] = [];
    #started = false;
    #closed = false;
    #ref = false;
    #scheduled = false;
    #webListeners = new Map<EventListenerOrEventListenerObject, Set<boolean>>();
    #onmessage: ((event: MessageEvent) => unknown) | null = null;
    onmessageerror: ((event: MessageEvent) => unknown) | null = null;

    constructor(key: object) {
      super();
      if (key !== token) throw new TypeError("Illegal constructor");
      EventEmitter.call(this);
      super.addEventListener("message", (event) => {
        if (!(event instanceof MessageEvent)) return;
        const data = messagePayloads.has(event) ? messagePayloads.get(event) : event.data;
        this.emit("message", data);
      });
      super.addEventListener("messageerror", (event) => { if (event instanceof MessageEvent) this.emit("messageerror", event.data); });
      super.addEventListener("close", () => this.emit("close"));
    }

    static pair(): [MessagePort, MessagePort] {
      const first = new MessagePort(token);
      const second = new MessagePort(token);
      first.#other = second;
      second.#other = first;
      return [first, second];
    }

    static receive(port: MessagePort) {
      if (!port.#queue.length) return undefined;
      return { message: port.#queue.shift() };
    }

    static isClosed(port: MessagePort) { return port.#closed; }

    get onmessage() { return this.#onmessage; }
    set onmessage(listener: ((event: MessageEvent) => unknown) | null) {
      this.#onmessage = typeof listener === "function" ? listener : null;
      if (this.#onmessage) { this.start(); this.ref(); }
      else if (!this.#hasMessageListeners()) this.unref();
    }

    addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: AddEventListenerOptions | boolean) {
      super.addEventListener(type, listener, options);
      if (type !== "message" || !listener) return;
      const captures = this.#webListeners.get(listener) || new Set<boolean>();
      captures.add(typeof options === "boolean" ? options : Boolean(options?.capture));
      this.#webListeners.set(listener, captures);
      this.start();
      this.ref();
    }

    removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: EventListenerOptions | boolean) {
      super.removeEventListener(type, listener, options);
      if (type !== "message" || !listener) return;
      const captures = this.#webListeners.get(listener);
      captures?.delete(typeof options === "boolean" ? options : Boolean(options?.capture));
      if (!captures?.size) this.#webListeners.delete(listener);
      if (!this.#hasMessageListeners()) this.unref();
    }

    #hasMessageListeners() {
      return this.#onmessage !== null || this.#webListeners.size > 0 || this.listenerCount("message") > 0;
    }

    postMessage(value: unknown, transfer?: unknown) {
      if (!arguments.length) throw Object.assign(new TypeError("Not enough arguments to MessagePort.postMessage"), { code: "ERR_MISSING_ARGS" });
      const message = clone(value, transferOptions(transfer));
      if (!this.#other || this.#closed) return;
      this.#other.#queue.push(message);
      this.#other.#schedule();
    }

    #schedule() {
      if (!this.#started || this.#scheduled || !this.#queue.length) return;
      this.#scheduled = true;
      setImmediate(() => this.#deliver());
    }

    #deliver() {
      this.#scheduled = false;
      if (!this.#started || !this.#queue.length) return;
      const data = this.#queue.shift();
      this.#schedule();
      this.dispatchEvent(messageEvent(data));
    }

    start() { this.#started = true; this.#schedule(); }
    ref() {
      if (this.#closed || this.#ref) return;
      this.#ref = true;
      internal.messagePortRefs++;
    }
    unref() {
      if (!this.#ref) return;
      this.#ref = false;
      internal.messagePortRefs--;
    }
    hasRef() { return this.#ref; }

    close(callback?: () => void) {
      if (typeof callback === "function") this.once("close", callback);
      if (this.#closed) return;
      const other = this.#other;
      this.#disconnect();
      if (other) other.#disconnect();
    }

    #disconnect() {
      this.#closed = true;
      this.unref();
      this.#other = null;
      setImmediate(() => this.#finishClose());
    }

    #finishClose() {
      if (this.#started && this.#queue.length) {
        setImmediate(() => this.#finishClose());
        return;
      }
      this.dispatchEvent(new Event("close"));
    }

    on(event: string | symbol, listener: BunWasm.EventListener) {
      EventEmitter.prototype.on.call(this, event, listener);
      if (event === "message") { this.start(); this.ref(); }
      return this;
    }
    addListener(event: string | symbol, listener: BunWasm.EventListener) { return this.on(event, listener); }
    once(event: string | symbol, listener: BunWasm.EventListener) {
      EventEmitter.prototype.once.call(this, event, listener);
      return this;
    }
    off(event: string | symbol, listener: BunWasm.EventListener) { return this.removeListener(event, listener); }
    removeListener(event: string | symbol, listener: BunWasm.EventListener) {
      EventEmitter.prototype.removeListener.call(this, event, listener);
      if (event === "message" && !this.#hasMessageListeners()) this.unref();
      return this;
    }
    removeAllListeners(event?: string | symbol) {
      if (arguments.length) EventEmitter.prototype.removeAllListeners.call(this, event);
      else EventEmitter.prototype.removeAllListeners.call(this);
      if (!this.#hasMessageListeners()) this.unref();
      return this;
    }
    emit(event: string | symbol, ...args: unknown[]) { return EventEmitter.prototype.emit.call(this, event, ...args); }
    listenerCount(event: string | symbol) { return EventEmitter.prototype.listenerCount.call(this, event); }
    listeners(event: string | symbol) { return EventEmitter.prototype.listeners.call(this, event); }
    rawListeners(event: string | symbol) { return EventEmitter.prototype.rawListeners.call(this, event); }
    eventNames() { return EventEmitter.prototype.eventNames.call(this); }
    getMaxListeners() { return EventEmitter.prototype.getMaxListeners.call(this); }
    setMaxListeners(count: number) { EventEmitter.prototype.setMaxListeners.call(this, count); return this; }
    prependListener(event: string | symbol, listener: BunWasm.EventListener) {
      EventEmitter.prototype.prependListener.call(this, event, listener);
      if (event === "message") { this.start(); this.ref(); }
      return this;
    }
    prependOnceListener(event: string | symbol, listener: BunWasm.EventListener) {
      EventEmitter.prototype.prependOnceListener.call(this, event, listener);
      return this;
    }
    get [Symbol.toStringTag]() { return "MessagePort"; }
  }

  class MessageChannel {
    readonly port1: MessagePort;
    readonly port2: MessagePort;
    constructor() { [this.port1, this.port2] = MessagePort.pair(); }
  }

  class BroadcastChannel extends EventTarget {
    readonly name: string;
    #closed = false;
    #ref = true;
    #queue: unknown[] = [];
    onmessage: ((event: MessageEvent) => unknown) | null = null;
    onmessageerror: ((event: MessageEvent) => unknown) | null = null;

    constructor(name: string) {
      super();
      if (!arguments.length) throw new TypeError("BroadcastChannel requires a name");
      this.name = String(name);
      const peers = channels.get(this.name) || new Set<BroadcastChannel>();
      peers.add(this);
      channels.set(this.name, peers);
      internal.messagePortRefs++;
    }

    static receive(channel: BroadcastChannel) {
      if (!channel.#queue.length) return undefined;
      return { message: channel.#queue.shift() };
    }

    postMessage(value: unknown) {
      if (this.#closed) throw new DOMException("BroadcastChannel is closed.", "InvalidStateError");
      if (!arguments.length) throw new TypeError("postMessage requires a message");
      const message = clone(value);
      for (const peer of channels.get(this.name) || []) {
        if (peer === this) continue;
        peer.#queue.push(clone(message));
        setImmediate(() => peer.#deliver());
      }
    }

    #deliver() {
      if (this.#closed || !this.#queue.length) return;
      this.dispatchEvent(messageEvent(this.#queue.shift()));
    }

    close() {
      if (this.#closed) return;
      this.#closed = true;
      this.unref();
      this.#queue.length = 0;
      const peers = channels.get(this.name);
      peers?.delete(this);
      if (!peers?.size) channels.delete(this.name);
    }
    ref() {
      if (!this.#closed && !this.#ref) { this.#ref = true; internal.messagePortRefs++; }
      return this;
    }
    unref() {
      if (this.#ref) { this.#ref = false; internal.messagePortRefs--; }
      return this;
    }
    get [Symbol.toStringTag]() { return "BroadcastChannel"; }
  }

  function receiveMessageOnPort(port: unknown) {
    if (port instanceof MessagePort) return MessagePort.receive(port);
    if (port instanceof BroadcastChannel) return BroadcastChannel.receive(port);
    throw invalidPort();
  }

  function moveMessagePortToContext(port: unknown, context: unknown): never {
    if (!(port instanceof MessagePort)) throw invalidPort();
    if (MessagePort.isClosed(port)) throw Object.assign(new Error("Cannot send data on closed MessagePort"), { code: "ERR_CLOSED_MESSAGE_PORT" });
    return unsupported("worker_threads.moveMessagePortToContext");
  }

  class Worker {
    constructor(filename: unknown, options?: unknown) { unsupported("worker_threads.Worker"); }
  }

  return {
    isMainThread: true, threadId: 0, parentPort: null, workerData: null, resourceLimits: {},
    SHARE_ENV: Symbol.for("nodejs.worker_threads.SHARE_ENV"),
    MessageChannel, MessagePort, BroadcastChannel, Worker,
    markAsUntransferable, isMarkedAsUntransferable, moveMessagePortToContext, receiveMessageOnPort,
    getEnvironmentData(key: unknown) { return environmentData.get(key); },
    setEnvironmentData(key: unknown, value: unknown) {
      if (value === undefined) environmentData.delete(key);
      else environmentData.set(key, value);
    },
  };
})
