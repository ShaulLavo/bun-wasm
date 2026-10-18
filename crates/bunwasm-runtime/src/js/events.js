// node:events polyfill. The factory returns the EventEmitter constructor itself
// (module.exports = EventEmitter), with Node's statics attached.
(function (internal) {
  "use strict";

  const kErrorMonitor = Symbol("events.errorMonitor");
  const kCaptureRejection = Symbol.for("nodejs.rejection");
  let defaultMaxListeners = 10;
  let captureRejectionsDefault = false;

  // ---------------------------------------------------------------------------
  // Errors
  // ---------------------------------------------------------------------------

  function makeError(Ctor, code, message) {
    const err = new Ctor(message);
    err.code = code;
    return err;
  }

  function inspect(value) {
    try {
      return internal.require("inspect").nodeInspect(value);
    } catch (_) {
      return typeof value === "string" ? `'${value}'` : String(value);
    }
  }

  function describeReceived(value) {
    if (value === null || value === undefined) return String(value);
    if (typeof value === "function") return `function ${value.name}`;
    if (typeof value === "object") {
      if (value.constructor && value.constructor.name) return `an instance of ${value.constructor.name}`;
      return inspect(value);
    }
    if (typeof value === "string") {
      const shown = value.length > 28 ? `${value.slice(0, 25)}...` : value;
      return `type string (${shown.indexOf("'") === -1 ? `'${shown}'` : JSON.stringify(shown)})`;
    }
    if (typeof value === "bigint") return `type bigint (${value}n)`;
    if (typeof value === "number" && Object.is(value, -0)) return "type number (-0)";
    return `type ${typeof value} (${String(value)})`;
  }

  function invalidArgType(name, type, value) {
    return makeError(
      TypeError,
      "ERR_INVALID_ARG_TYPE",
      `The "${name}" argument must be ${type}. Received ${describeReceived(value)}`,
    );
  }

  function checkListener(listener) {
    if (typeof listener !== "function") throw invalidArgType("listener", "of type function", listener);
  }

  function checkMaxListeners(n, name) {
    if (typeof n !== "number") throw invalidArgType(name, "of type number", n);
    if (n < 0 || n !== n) {
      throw makeError(
        RangeError,
        "ERR_OUT_OF_RANGE",
        `The value of "${name}" is out of range. It must be >= 0. Received ${String(n)}`,
      );
    }
  }

  function emitWarning(warning) {
    const proc = typeof process !== "undefined" ? process : undefined;
    if (proc && typeof proc.emitWarning === "function") {
      proc.emitWarning(warning);
      return;
    }
    if (typeof console !== "undefined") console.error(`${warning.name}: ${warning.message}`);
  }

  // ---------------------------------------------------------------------------
  // EventEmitter
  // ---------------------------------------------------------------------------

  function EventEmitter(opts) {
    EventEmitter.init.call(this, opts);
  }

  EventEmitter.prototype._eventsCount = 0;

  EventEmitter.init = function init(opts) {
    if (this._events === undefined || this._events === Object.getPrototypeOf(this)._events) {
      this._events = Object.create(null);
      this._eventsCount = 0;
    }
    this._maxListeners = this._maxListeners || undefined;
    if (opts && opts.captureRejections !== undefined) {
      if (typeof opts.captureRejections !== "boolean") {
        throw invalidArgType("options.captureRejections", "of type boolean", opts.captureRejections);
      }
    }
  };

  function ensureEvents(target) {
    if (target._events === undefined) {
      target._events = Object.create(null);
      target._eventsCount = 0;
    }
    return target._events;
  }

  function maxListenersOf(target) {
    return target._maxListeners === undefined ? defaultMaxListeners : target._maxListeners;
  }

  function emitterName(target) {
    return (target.constructor && target.constructor.name) || "EventEmitter";
  }

  function warnIfLeaking(target, type, list) {
    const m = maxListenersOf(target);
    if (!(m > 0) || list.length <= m || list.warned) return;
    list.warned = true;
    const typeName = typeof type === "symbol" ? type.toString() : String(type);
    const warning = new Error(
      `Possible EventEmitter memory leak detected. ${list.length} ${typeName} listeners ` +
        `added to [${emitterName(target)}]. MaxListeners is ${m}. Use emitter.setMaxListeners() to increase limit`,
    );
    warning.name = "MaxListenersExceededWarning";
    warning.emitter = target;
    warning.type = type;
    warning.count = list.length;
    emitWarning(warning);
  }

  function publishAdded(target, type, undo) {
    if (!internal.listenerChanged) return;
    try { internal.listenerChanged(target, type); } catch (error) { undo(); throw error; }
  }

  function addListener(target, type, listener, prepend) {
    checkListener(listener);
    let events = ensureEvents(target);
    if (events.newListener !== undefined) {
      target.emit("newListener", type, listener.listener ? listener.listener : listener);
      events = target._events;
    }
    const existing = events[type];
    if (existing === undefined) {
      events[type] = listener;
      target._eventsCount++;
      // A rejected registration (an unsupported signal) leaves no trace of the listener.
      publishAdded(target, type, () => { delete events[type]; target._eventsCount--; });
      return target;
    }
    let list = existing;
    if (typeof existing === "function") {
      list = prepend ? [listener, existing] : [existing, listener];
      events[type] = list;
    } else if (prepend) {
      list.unshift(listener);
    } else {
      list.push(listener);
    }
    publishAdded(target, type, () => {
      if (typeof existing === "function") events[type] = existing;
      else list.splice(list.indexOf(listener), 1);
    });
    warnIfLeaking(target, type, list);
    return target;
  }

  function onceWrapper() {
    if (this.fired) return undefined;
    this.target.removeListener(this.type, this.wrapFn);
    this.fired = true;
    return this.listener.apply(this.target, arguments);
  }

  function onceWrap(target, type, listener) {
    const state = { fired: false, wrapFn: undefined, target, type, listener };
    const wrapped = onceWrapper.bind(state);
    wrapped.listener = listener;
    state.wrapFn = wrapped;
    return wrapped;
  }

  function throwUnhandledError(target, args) {
    const er = args.length > 0 ? args[0] : undefined;
    if (er instanceof Error) throw er;
    const err = new Error(`Unhandled error. (${inspect(er)})`);
    err.code = "ERR_UNHANDLED_ERROR";
    err.context = er;
    throw err;
  }

  function callListeners(target, handler, args) {
    if (typeof handler === "function") {
      handler.apply(target, args);
      return;
    }
    // Copy so listeners added or removed during emit don't affect this round.
    const listeners = handler.slice();
    for (let i = 0; i < listeners.length; i++) listeners[i].apply(target, args);
  }

  function unwrapListeners(list) {
    return Array.from(list, (fn) => fn.listener || fn);
  }

  const proto = EventEmitter.prototype;

  proto.setMaxListeners = function setMaxListeners(n) {
    checkMaxListeners(n, "setMaxListeners");
    this._maxListeners = n;
    return this;
  };

  proto.getMaxListeners = function getMaxListeners() {
    return maxListenersOf(this);
  };

  proto.emit = function emit(type) {
    const args = Array.prototype.slice.call(arguments, 1);
    const events = this._events;
    if (type === "error" && events !== undefined && events[kErrorMonitor] !== undefined) {
      this.emit.apply(this, [kErrorMonitor].concat(args));
    }
    const handler = events === undefined ? undefined : events[type];
    if (handler === undefined) {
      if (type === "error") throwUnhandledError(this, args);
      return false;
    }
    callListeners(this, handler, args);
    return true;
  };

  proto.addListener = function addListenerMethod(type, listener) {
    return addListener(this, type, listener, false);
  };
  proto.on = proto.addListener;

  proto.prependListener = function prependListener(type, listener) {
    return addListener(this, type, listener, true);
  };

  proto.once = function once(type, listener) {
    checkListener(listener);
    this.on(type, onceWrap(this, type, listener));
    return this;
  };

  proto.prependOnceListener = function prependOnceListener(type, listener) {
    checkListener(listener);
    this.prependListener(type, onceWrap(this, type, listener));
    return this;
  };

  function deleteType(target, type) {
    if (--target._eventsCount === 0) target._events = Object.create(null);
    else delete target._events[type];
    if (internal.listenerChanged) internal.listenerChanged(target, type);
  }

  function findListenerIndex(list, listener) {
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i] === listener || list[i].listener === listener) return i;
    }
    return -1;
  }

  proto.removeListener = function removeListener(type, listener) {
    checkListener(listener);
    const events = this._events;
    if (events === undefined) return this;
    const list = events[type];
    if (list === undefined) return this;

    if (list === listener || list.listener === listener) {
      deleteType(this, type);
      if (events.removeListener !== undefined) this.emit("removeListener", type, list.listener || listener);
      return this;
    }
    if (typeof list === "function") return this;

    const index = findListenerIndex(list, listener);
    if (index < 0) return this;
    const removed = list[index];
    list.splice(index, 1);
    if (list.length === 1) events[type] = list[0];
    if (internal.listenerChanged) internal.listenerChanged(this, type);
    if (events.removeListener !== undefined) this.emit("removeListener", type, removed.listener || listener);
    return this;
  };
  proto.off = proto.removeListener;

  function removeAllOfType(target, type) {
    const listeners = target._events[type];
    if (typeof listeners === "function") {
      target.removeListener(type, listeners);
      return;
    }
    if (listeners === undefined) return;
    // LIFO order, like Node.
    for (let i = listeners.length - 1; i >= 0; i--) target.removeListener(type, listeners[i]);
  }

  proto.removeAllListeners = function removeAllListeners(type) {
    const events = this._events;
    if (events === undefined) return this;

    // Without 'removeListener' listeners there is nothing to notify.
    if (events.removeListener === undefined) {
      if (arguments.length === 0) {
        this._events = Object.create(null);
        this._eventsCount = 0;
        if (internal.listenerChanged) internal.listenerChanged(this);
      } else if (events[type] !== undefined) {
        deleteType(this, type);
      }
      return this;
    }

    if (arguments.length !== 0) {
      removeAllOfType(this, type);
      return this;
    }
    for (const key of Reflect.ownKeys(events)) {
      if (key !== "removeListener") removeAllOfType(this, key);
    }
    removeAllOfType(this, "removeListener");
    this._events = Object.create(null);
    this._eventsCount = 0;
    if (internal.listenerChanged) internal.listenerChanged(this);
    return this;
  };

  function listenersOf(target, type, unwrap) {
    const events = target._events;
    if (events === undefined) return [];
    const listener = events[type];
    if (listener === undefined) return [];
    if (typeof listener === "function") return unwrap ? [listener.listener || listener] : [listener];
    return unwrap ? unwrapListeners(listener) : listener.slice();
  }

  proto.listeners = function listeners(type) {
    return listenersOf(this, type, true);
  };

  proto.rawListeners = function rawListeners(type) {
    return listenersOf(this, type, false);
  };

  function listenerCount(type, listener) {
    const events = this._events;
    if (events === undefined) return 0;
    const evlistener = events[type];
    if (evlistener === undefined) return 0;
    const list = typeof evlistener === "function" ? [evlistener] : evlistener;
    if (listener === undefined || listener === null) return list.length;
    let count = 0;
    for (const fn of list) {
      if (fn === listener || fn.listener === listener) count++;
    }
    return count;
  }

  proto.listenerCount = listenerCount;

  proto.eventNames = function eventNames() {
    return this._eventsCount > 0 ? Reflect.ownKeys(this._events) : [];
  };

  // ---------------------------------------------------------------------------
  // Statics
  // ---------------------------------------------------------------------------

  EventEmitter.EventEmitter = EventEmitter;
  EventEmitter.usingDomains = false;
  EventEmitter.captureRejectionSymbol = kCaptureRejection;
  EventEmitter.errorMonitor = kErrorMonitor;
  EventEmitter.kMaxEventTargetListeners = Symbol("events.maxEventTargetListeners");
  EventEmitter.kMaxEventTargetListenersWarned = Symbol("events.maxEventTargetListenersWarned");

  Object.defineProperty(EventEmitter, "defaultMaxListeners", {
    enumerable: true,
    get() {
      return defaultMaxListeners;
    },
    set(n) {
      checkMaxListeners(n, "defaultMaxListeners");
      defaultMaxListeners = n;
    },
  });

  Object.defineProperty(EventEmitter, "captureRejections", {
    enumerable: true,
    get() {
      return captureRejectionsDefault;
    },
    set(value) {
      if (typeof value !== "boolean") throw invalidArgType("EventEmitter.captureRejections", "of type boolean", value);
      captureRejectionsDefault = value;
    },
  });

  EventEmitter.listenerCount = function staticListenerCount(emitter, type) {
    if (typeof emitter.listenerCount === "function") return emitter.listenerCount(type);
    return listenerCount.call(emitter, type);
  };

  function isEventTarget(value) {
    return value !== null && typeof value === "object" && typeof value.addEventListener === "function";
  }

  EventEmitter.getEventListeners = function getEventListeners(emitterOrTarget, type) {
    if (typeof emitterOrTarget.listeners === "function") return emitterOrTarget.listeners(type);
    return [];
  };

  EventEmitter.getMaxListeners = function getMaxListeners(emitterOrTarget) {
    if (typeof emitterOrTarget.getMaxListeners === "function") return emitterOrTarget.getMaxListeners();
    return defaultMaxListeners;
  };

  EventEmitter.setMaxListeners = function setMaxListeners(n = defaultMaxListeners) {
    checkMaxListeners(n, "n");
    const targets = Array.prototype.slice.call(arguments, 1);
    if (targets.length === 0) {
      defaultMaxListeners = n;
      return;
    }
    for (const target of targets) {
      if (typeof target.setMaxListeners === "function") target.setMaxListeners(n);
      else throw invalidArgType("eventTargets", "an instance of EventEmitter or EventTarget", target);
    }
  };

  function abortError(signal) {
    const err = new Error("The operation was aborted");
    err.name = "AbortError";
    err.code = "ABORT_ERR";
    if (signal && signal.reason !== undefined) err.cause = signal.reason;
    return err;
  }

  function validateSignal(signal) {
    if (signal === undefined) return;
    if (signal === null || typeof signal !== "object" || !("aborted" in signal)) {
      throw invalidArgType("options.signal", "an instance of AbortSignal", signal);
    }
  }

  function listen(target, name, handler, flags) {
    if (typeof target.on === "function") {
      if (flags.once) target.once(name, handler);
      else target.on(name, handler);
      return () => target.removeListener(name, handler);
    }
    if (isEventTarget(target)) {
      target.addEventListener(name, handler, flags);
      return () => target.removeEventListener(name, handler, flags);
    }
    throw invalidArgType("emitter", "an instance of EventEmitter or EventTarget", target);
  }

  EventEmitter.once = function once(emitter, name, options) {
    const signal = options ? options.signal : undefined;
    validateSignal(signal);
    if (signal && signal.aborted) return Promise.reject(abortError(signal));
    return new Promise((resolve, reject) => {
      let removeError = () => {};
      let removeAbort = () => {};
      const removeEvent = listen(
        emitter,
        name,
        function () {
          removeError();
          removeAbort();
          resolve(Array.prototype.slice.call(arguments));
        },
        { once: true },
      );
      if (name !== "error" && typeof emitter.once === "function") {
        removeError = listen(
          emitter,
          "error",
          (err) => {
            removeEvent();
            removeAbort();
            reject(err);
          },
          { once: true },
        );
      }
      if (!signal) return;
      const onAbort = () => {
        removeEvent();
        removeError();
        reject(abortError(signal));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      removeAbort = () => signal.removeEventListener("abort", onAbort);
    });
  };

  // Async iterator over `event` emissions. Each item is the array of emitted args.
  EventEmitter.on = function on(emitter, event, options) {
    const signal = options ? options.signal : undefined;
    validateSignal(signal);
    if (signal && signal.aborted) throw abortError(signal);
    const close = options && options.close ? options.close : [];
    const queue = [];
    const waiters = [];
    let error = null;
    let finished = false;
    const removers = [];

    function settle(result) {
      if (waiters.length > 0) waiters.shift().resolve(result);
      else queue.push(result);
    }
    function onEvent() {
      settle({ value: Array.prototype.slice.call(arguments), done: false });
    }
    function onError(err) {
      if (waiters.length > 0) {
        waiters.shift().reject(err);
        finish();
        return;
      }
      error = err;
      finish();
    }
    function finish() {
      if (finished) return;
      finished = true;
      for (const remove of removers) remove();
      for (const waiter of waiters.splice(0)) waiter.resolve({ value: undefined, done: true });
    }

    removers.push(listen(emitter, event, onEvent, {}));
    if (event !== "error" && typeof emitter.on === "function") removers.push(listen(emitter, "error", onError, {}));
    for (const name of close) removers.push(listen(emitter, name, () => settleClose(), {}));
    function settleClose() {
      queue.push({ value: undefined, done: true, close: true });
      if (waiters.length > 0) waiters.shift().resolve(queue.shift());
      finish();
    }
    if (signal) {
      const onAbort = () => onError(abortError(signal));
      signal.addEventListener("abort", onAbort, { once: true });
      removers.push(() => signal.removeEventListener("abort", onAbort));
    }

    const iterator = {
      next() {
        if (queue.length > 0) {
          const item = queue.shift();
          return Promise.resolve(item.close ? { value: undefined, done: true } : item);
        }
        if (error) {
          const err = error;
          error = null;
          return Promise.reject(err);
        }
        if (finished) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
      },
      return() {
        finish();
        return Promise.resolve({ value: undefined, done: true });
      },
      throw(err) {
        finish();
        return Promise.reject(err);
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
    return iterator;
  };

  EventEmitter.addAbortListener = function addAbortListener(signal, listener) {
    validateSignal(signal);
    checkListener(listener);
    if (signal.aborted) {
      queueMicrotask(() => listener());
      return { [Symbol.dispose || Symbol.for("Symbol.dispose")]() {} };
    }
    signal.addEventListener("abort", listener, { once: true });
    return {
      [Symbol.dispose || Symbol.for("Symbol.dispose")]() {
        signal.removeEventListener("abort", listener);
      },
    };
  };

  return EventEmitter;
});
