// A resource's callback frame: the async context its own callbacks run in, captured when the
// resource is created, entered for each of its dispatches, and dropped when it retires. The host
// enters every event-loop turn at the root frame, so a resource that delivers callbacks from the
// I/O pump captures the frame it belongs to here. Callbacks it queues (ticks, immediates, Promise
// reactions) still capture their own frame where they are queued; releasing a resource never
// clears those.
(function (internal: BunWasm.Internal) {
  "use strict";
  type Live = { readonly kind: "live"; readonly context: unknown };
  type State = Live | { readonly kind: "retired" };
  const RETIRED: State = { kind: "retired" };

  function capture(): BunWasm.ResourceFrame {
    let state: State = { kind: "live", context: internal.native.getAsyncContext() };
    return {
      run(callback, receiver, args) {
        if (state.kind === "retired") return undefined;
        return internal.runInContext(state.context, callback, receiver, args);
      },
      bind(waiter) {
        const target: BunWasm.IoWaiter = waiter;
        const { step, fail } = target;
        // The frame of a step that threw, held only until the pump calls fail right after it:
        // a listener may close the resource (releasing it) and then throw, and the error still
        // belongs to that dispatch.
        let failing: Live | null = null;
        target.step = function framedStep() {
          if (state.kind === "retired") return true;
          const invocation = state;
          try {
            return internal.runInContext(invocation.context, step, waiter, []);
          } catch (error) {
            failing = invocation;
            throw error;
          }
        };
        target.fail = function framedFail(error) {
          const invocation = failing ?? (state.kind === "live" ? state : null);
          failing = null;
          if (invocation) internal.runInContext(invocation.context, fail, waiter, [error]);
        };
        return waiter;
      },
      release() {
        state = RETIRED;
      },
    };
  }

  return { capture };
})
