(function (internal: BunWasm.Internal) {
  "use strict";

  type Callback = (...args: unknown[]) => unknown;
  type TimerKind = "timeout" | "interval" | "immediate";
  interface Clock {
    elapsed: number;
    origin: number;
    firing: number;
    readonly timers: Map<number, FakeTimeout>;
  }

  const RealDate = Date;
  const realNow = RealDate.now;
  let clock: Clock | null = null;
  let wallTime: number | null = null;
  let sequence = -1;

  function now() {
    return wallTime === null ? realNow() : wallTime;
  }

  const MockDate = new Proxy(RealDate.bind(null), {
    construct(_target, args: unknown[], newTarget) {
      return Reflect.construct(RealDate, args.length === 0 && wallTime !== null ? [wallTime] : args, newTarget);
    },
    apply() {
      return new RealDate(now()).toString();
    },
  });
  Object.defineProperties(MockDate, Object.getOwnPropertyDescriptors(RealDate));
  Object.defineProperty(MockDate, "now", { value: now, configurable: true, writable: true });
  Object.defineProperty(RealDate.prototype, "constructor", { value: MockDate, configurable: true, writable: true });
  globalThis.Date = MockDate;

  // Native Intl uses the engine's wall clock when its date argument is omitted.
  const dateTimePrototype = Intl.DateTimeFormat.prototype;
  const formatGetter = Object.getOwnPropertyDescriptor(dateTimePrototype, "format")?.get;
  const formats = new WeakMap<object, (value?: number | Date) => string>();
  if (formatGetter) Object.defineProperty(dateTimePrototype, "format", {
    configurable: true,
    get() {
      const nativeFormat: (value: number | Date) => string = formatGetter.call(this);
      let format = formats.get(this);
      if (format) return format;
      format = (value) => nativeFormat(value === undefined ? now() : value);
      formats.set(this, format);
      return format;
    },
  });
  const formatToParts = dateTimePrototype.formatToParts;
  dateTimePrototype.formatToParts = function (value) {
    return formatToParts.call(this, value === undefined ? now() : value);
  };

  function activeClock() {
    if (!clock) throw new Error("Fake timers are not active. Call useFakeTimers() first.");
    return clock;
  }

  function updateTime(current: Clock, elapsed: number) {
    current.elapsed = elapsed;
    wallTime = Math.floor(current.origin + elapsed / 1e6);
  }

  function timestamp(value: unknown, name: string) {
    const result = value instanceof RealDate ? value.getTime() : value;
    if (typeof result !== "number" || !Number.isFinite(result)) {
      throw new TypeError(`${name} expects a finite number or a valid Date`);
    }
    return Math.floor(result);
  }

  function marker(enabled: boolean) {
    const timeout = globalThis.setTimeout;
    if ((typeof timeout !== "object" || timeout === null) && typeof timeout !== "function") return;
    if (enabled) Object.defineProperty(timeout, "clock", { value: true, configurable: true, writable: true });
    else Reflect.deleteProperty(timeout, "clock");
  }

  function useFakeTimers(this: unknown, options?: unknown) {
    let initial = realNow();
    if (options !== undefined && typeof options !== "string") {
      if (options === null || typeof options !== "object") throw new TypeError("useFakeTimers() expects an options object");
      const value = "now" in options ? options.now : undefined;
      if (value !== undefined) initial = timestamp(value, "'now'");
    }
    if (clock) {
      clock.elapsed = 0;
      clock.origin = Math.floor(initial);
    } else {
      clock = { elapsed: 0, origin: Math.floor(initial), firing: 0, timers: new Map() };
    }
    wallTime = Math.floor(initial);
    marker(true);
    return this;
  }

  function useRealTimers(this: unknown) {
    if (clock) clock.timers.clear();
    clock = null;
    wallTime = null;
    marker(false);
    return this;
  }

  function setSystemTime(this: unknown, value?: unknown) {
    const ms = value instanceof RealDate ? value.getTime() : value;
    if (ms === Infinity || ms === -Infinity) throw new TypeError("setSystemTime() expects a finite number or a Date");
    wallTime = typeof ms === "number" && !Number.isNaN(ms) ? Math.trunc(ms) : null;
    if (clock && wallTime !== null) clock.origin = wallTime - clock.elapsed / 1e6;
    return this;
  }

  class FakeTimeout {
    readonly id = sequence--;
    order = sequence--;
    readonly context = internal.native.getAsyncContext();
    due: number;
    readonly owner: Clock;
    readonly kind: TimerKind;
    readonly callback: Callback;
    readonly args: unknown[];
    readonly delay: number;
    private refed = true;
    cancelled = false;

    constructor(
      owner: Clock,
      kind: TimerKind,
      callback: Callback,
      args: unknown[],
      delay: number,
    ) {
      this.owner = owner;
      this.kind = kind;
      this.callback = callback;
      this.args = args;
      this.delay = delay;
      this.due = owner.elapsed + delay;
      owner.timers.set(this.id, this);
    }
    ref() { this.refed = true; return this; }
    unref() { this.refed = false; return this; }
    hasRef() { return this.refed; }
    refresh() {
      if (this.cancelled || clock !== this.owner) return this;
      this.due = this.owner.elapsed + Math.max(this.delay, this.owner.firing ? 1e6 : 0);
      this.order = sequence--;
      this.owner.timers.set(this.id, this);
      return this;
    }
    close() {
      this.cancelled = true;
      this.owner.timers.delete(this.id);
      return this;
    }
    [Symbol.toPrimitive]() { return this.id; }
  }

  function schedule(callback: Callback, delay: unknown, args: unknown[], kind: TimerKind) {
    const current = activeClock();
    let ms = Number(delay);
    if (!(ms >= 1) || ms > 2147483647) ms = 1;
    const duration = Math.max(kind === "immediate" ? 0 : Math.trunc(ms) * 1e6, current.firing ? 1e6 : 0);
    return new FakeTimeout(current, kind, callback, args, duration);
  }

  function clear(handle: unknown) {
    if (handle instanceof FakeTimeout) { handle.close(); return true; }
    if (typeof handle !== "number" && typeof handle !== "string") return false;
    const timer = clock?.timers.get(Number(handle));
    if (!timer) return false;
    timer.close();
    return true;
  }

  function next(current: Clock) {
    let first: FakeTimeout | undefined;
    for (const timer of current.timers.values()) {
      if (!first || timer.due < first.due || (timer.due === first.due && timer.order > first.order)) first = timer;
    }
    return first;
  }

  function fire(current: Clock, timer: FakeTimeout) {
    const nextDue = timer.due;
    updateTime(current, Math.max(current.elapsed, nextDue));
    current.timers.delete(timer.id);
    current.firing++;
    try {
      internal.runInContext(timer.context, timer.callback, timer, timer.args);
      internal.runTicks();
      // The runtime-owned nextTick queue is synchronous here. Native Promise jobs
      // keep each engine's existing checkpoint behavior.
      internal.native.runMicrotasks();
    } catch (error) {
      if (!internal.handleUncaught(error)) internal.native.exit(1);
    } finally {
      current.firing--;
    }
    if (timer.kind !== "interval" || clock !== current || current.timers.has(timer.id) || timer.cancelled) return;
    timer.due = nextDue + timer.delay;
    timer.order = sequence--;
    current.timers.set(timer.id, timer);
  }

  function drain(current: Clock, until: number) {
    let count = 0;
    let timer = next(current);
    while (clock === current && timer && timer.due <= until) {
      if (++count > 100000) throw new Error("Aborting after running 100000 timers, assuming an infinite loop!");
      fire(current, timer);
      timer = next(current);
    }
  }

  function advanceTimersByTime(this: unknown, ms: unknown) {
    const current = activeClock();
    if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0 || ms > 4294967295) {
      throw new TypeError("advanceTimersByTime() expects milliseconds >= 0 and <= 4294967295");
    }
    const target = current.elapsed + Math.floor((ms === 0 ? 1 : ms) * 1e6);
    drain(current, target);
    if (clock === current) updateTime(current, Math.max(target, current.elapsed));
    return this;
  }

  function runAllTimers(this: unknown) {
    drain(activeClock(), Infinity);
    return this;
  }

  function runOnlyPendingTimers(this: unknown) {
    const current = activeClock();
    const until = Array.from(current.timers.values(), (timer) => timer.due).reduce((max, due) => Math.max(max, due), current.elapsed);
    drain(current, until);
    return this;
  }

  function clearAllTimers(this: unknown) {
    for (const timer of activeClock().timers.values()) timer.close();
    return this;
  }

  function advanceTimersToNextTimer(this: unknown) {
    const current = activeClock();
    const timer = next(current);
    if (timer) fire(current, timer);
    return this;
  }

  return {
    get active() { return clock !== null; },
    get elapsedNanoseconds() { return clock?.elapsed; },
    get timeOrigin() { return wallTime === null ? undefined : clock?.origin; },
    schedule,
    clear,
    api: { useFakeTimers, useRealTimers, setSystemTime, advanceTimersByTime, runAllTimers, runOnlyPendingTimers,
      clearAllTimers, advanceTimersToNextTimer, getTimerCount: () => activeClock().timers.size,
      isFakeTimers: () => clock !== null, now },
  };
})
