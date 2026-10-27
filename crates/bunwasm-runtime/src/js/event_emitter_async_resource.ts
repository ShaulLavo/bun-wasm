(function (internal: BunWasm.Internal) {
  "use strict";
  const EventEmitter = internal.require("events");
  const { AsyncResource } = internal.builtin("node:async_hooks");

  class ReferencingResource extends AsyncResource {
    #emitter: object;
    constructor(emitter: object, name: string, options: BunWasm.AsyncResourceOptions | undefined) {
      super(name, options);
      this.#emitter = emitter;
    }
    get eventEmitter() { return this.#emitter; }
  }

  class EventEmitterAsyncResource extends EventEmitter {
    #resource: ReferencingResource;
    constructor(options?: string | (BunWasm.AsyncResourceOptions & { name?: string; captureRejections?: boolean })) {
      const settings = typeof options === "string" ? undefined : options;
      const name = typeof options === "string" ? options : settings?.name;
      if (new.target === EventEmitterAsyncResource && typeof name !== "string") {
        throw Object.assign(new TypeError('The "options.name" property must be of type string'), { code: "ERR_INVALID_ARG_TYPE" });
      }
      super(settings);
      this.#resource = new ReferencingResource(this, name || new.target.name, settings);
    }
    get asyncId() { return this.#resource.asyncId(); }
    get triggerAsyncId() { return this.#resource.triggerAsyncId(); }
    get asyncResource() { return this.#resource; }
    emit(event: string | symbol, ...args: unknown[]) {
      return this.#resource.runInAsyncScope(super.emit, this, event, ...args);
    }
    emitDestroy() { this.#resource.emitDestroy(); }
  }
  return EventEmitterAsyncResource;
})
