(function (internal: BunWasm.Internal) {
  "use strict";
  const native = internal.native;
  type Kind = BunWasm.HTMLHandlerKind;
  type Callback = (this: object, token: Token) => unknown;
  type Registration = { selector: string | null; receiver: object; handlers: Partial<Record<Kind, Callback>> };
  type Options = { html?: boolean };
  const encoder = new TextEncoder();
  const empty = new Uint8Array();
  const finalizers = new FinalizationRegistry<number>(id => native.htmlClose(id));

  function domString(value: unknown) {
    if (typeof value === "symbol") throw new TypeError("Cannot convert a Symbol value to a string");
    return String(value);
  }

  function promise(value: unknown): Promise<unknown> | undefined {
    if ((typeof value !== "object" || value === null) && typeof value !== "function") return;
    const then = Reflect.get(value, "then");
    if (typeof then !== "function") return;
    return new Promise<void>((resolve, reject) => Reflect.apply(then, value, [() => resolve(undefined), reject]));
  }

  class Token {
    #attributesVersion = 0;
    #rewrite: Rewrite | undefined;
    constructor(rewrite: Rewrite) { this.#rewrite = rewrite; }
    detach() { this.#rewrite = undefined; }
    call<K extends keyof BunWasm.HTMLTokenValues>(action: K, value = "", options?: Options, extra?: string | number): BunWasm.HTMLTokenValues[K] | undefined {
      if (!this.#rewrite) return undefined;
      return native.htmlToken(this.#rewrite.id, action, value, !!options?.html, extra);
    }
    before(content: unknown, options?: Options) { if (!this.#rewrite) return this; this.call("before", domString(content), options); return this; }
    after(content: unknown, options?: Options) { if (!this.#rewrite) return this; this.call("after", domString(content), options); return this; }
    replace(content: unknown, options?: Options) { if (!this.#rewrite) return this; this.call("replace", domString(content), options); return this; }
    prepend(content: unknown, options?: Options) { if (!this.#rewrite) return this; this.call("prepend", domString(content), options); return this; }
    append(content: unknown, options?: Options) { if (!this.#rewrite) return this; this.call("append", domString(content), options); return this; }
    setInnerContent(content: unknown, options?: Options) { if (!this.#rewrite) return this; this.call("setInnerContent", domString(content), options); return this; }
    remove() { this.call("remove"); return this; }
    removeAndKeepContent() { this.call("removeAndKeepContent"); return this; }
    getAttribute(name: unknown) { if (!this.#rewrite) return undefined; return this.call("getAttribute", domString(name)); }
    hasAttribute(name: unknown) { if (!this.#rewrite) return undefined; return this.call("hasAttribute", domString(name)); }
    setAttribute(name: unknown, value: unknown) { if (!this.#rewrite) return this; this.call("setAttribute", domString(name), undefined, domString(value)); this.#attributesVersion++; return this; }
    removeAttribute(name: unknown) { if (!this.#rewrite) return this; this.call("removeAttribute", domString(name)); this.#attributesVersion++; return this; }
    get tagName() { return this.call("tagName"); }
    set tagName(name: unknown) { if (!this.#rewrite) return; this.call("setTagName", domString(name)); }
    get removed() { return this.call("removed"); }
    get selfClosing() { return this.call("selfClosing"); }
    get canHaveContent() { return this.call("canHaveContent"); }
    get namespaceURI() { return this.call("namespaceURI"); }
    get attributes() {
      const values = this.call("attributes") ?? [];
      const version = this.#attributesVersion;
      // oxlint-disable-next-line no-this-alias -- Retain the owner for callbacks whose receiver differs.
      const token = this;
      return (function* () {
        for (const pair of values) {
          if (!token.#rewrite || token.#attributesVersion !== version) return;
          yield pair;
        }
      })();
    }
    get text() { return this.call("text"); }
    set text(text: unknown) { if (!this.#rewrite) return; this.call("setText", domString(text)); }
    get lastInTextNode() { return this.call("lastInTextNode"); }
    get name() { return this.call("name"); }
    set name(name: unknown) { if (!this.#rewrite) return; this.call("setName", domString(name)); }
    get publicId() { return this.call("publicId"); }
    get systemId() { return this.call("systemId"); }
    onEndTag(callback: Callback) {
      if (!this.#rewrite) return this;
      if (typeof callback !== "function") throw new TypeError("Expected a function");
      const index = this.#rewrite.registerEndTag(callback, this);
      try {
        const replaced = this.call("onEndTag", "", undefined, index);
        if (replaced !== undefined) this.#rewrite.unregisterEndTag(replaced);
      } catch (error) {
        this.#rewrite.unregisterEndTag(index);
        throw error;
      }
      return this;
    }
  }

  class Rewrite {
    readonly id: number;
    closed = false;
    active: Token | undefined;
    readonly #endTags = new Map<number, Registration>();
    #nextEndTag: number;
    readonly registrations: Registration[];
    constructor(registrations: Registration[]) {
      this.registrations = registrations;
      this.#nextEndTag = registrations.length;
      this.id = native.htmlCreate(JSON.stringify(registrations.map(({ selector, handlers }) => Object.assign({ selector },
        Object.fromEntries(Object.keys(handlers).map(kind => [kind, true]))))));
      finalizers.register(this, this.id, this);
    }
    close() {
      if (this.closed) return;
      this.closed = true;
      if (this.active) this.active.detach();
      this.active = undefined;
      this.registrations.length = 0;
      this.#endTags.clear();
      native.htmlClose(this.id);
      finalizers.unregister(this);
    }
    registerEndTag(callback: Callback, receiver: object) {
      const id = this.#nextEndTag++;
      this.#endTags.set(id, { selector: null, receiver, handlers: { endTag: callback } });
      return id;
    }
    unregisterEndTag(id: number) { this.#endTags.delete(id); }
    invoke(event: BunWasm.HTMLStepEvent) {
      const registration = event.kind === "endTag" ? this.#endTags.get(event.handler) : this.registrations[event.handler];
      if (event.kind === "endTag") this.#endTags.delete(event.handler);
      if (!registration) throw new Error("Missing HTML content registration");
      const callback = registration.handlers[event.kind];
      if (!callback) throw new Error("Missing HTML content handler");
      const token = new Token(this);
      this.active = token;
      const result: unknown = Reflect.apply(callback, registration.receiver, [token]);
      if (result instanceof Error) throw result;
      return promise(result);
    }
    resume() {
      if (this.active) this.active.detach();
      this.active = undefined;
      return native.htmlStep(this.id, "resume", empty);
    }
    sync(bytes: Uint8Array) {
      const output: Uint8Array[] = [];
      try {
        this.syncStep(native.htmlStep(this.id, "write", bytes), output);
        this.syncStep(native.htmlStep(this.id, "end", empty), output);
        const length = output.reduce((n, chunk) => n + chunk.length, 0);
        const result = new Uint8Array(length);
        let offset = 0;
        for (const chunk of output) { result.set(chunk, offset); offset += chunk.length; }
        return result;
      } finally { this.close(); }
    }
    syncStep(step: BunWasm.HTMLStep, output: Uint8Array[]) {
      output.push(step.output);
      while (step.event) {
        const pending = this.invoke(step.event);
        if (pending) { pending.catch(() => {}); throw new TypeError("HTMLRewriter.transform() cannot synchronously return a body when a handler returns a Promise. Use a Response input."); }
        step = this.resume();
        output.push(step.output);
      }
    }
    async asyncStep(step: BunWasm.HTMLStep, controller: ReadableStreamDefaultController<Uint8Array>) {
      if (step.output.length) controller.enqueue(step.output);
      while (step.event && !this.closed) {
        const pending = this.invoke(step.event);
        if (pending) await pending;
        if (this.closed) return;
        step = this.resume();
        if (step.output.length) controller.enqueue(step.output);
      }
    }
    stream(input: Response) {
      if (input.bodyUsed) { this.close(); throw new TypeError("Response body already used"); }
      const buffered: unknown = Reflect.get(input, "_stream") ? undefined : Reflect.get(input, "_body");
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try { reader = input.body?.getReader(); }
      catch (error) { this.close(); throw error; }
      if (reader) Reflect.set(input, "_bodyUsed", true);
      // oxlint-disable-next-line no-this-alias -- Retain the owner for callbacks whose receiver differs.
      const rewrite = this;
      return new ReadableStream<Uint8Array>({
        start(controller) {
          if (buffered instanceof Uint8Array) return rewrite.buffered(buffered, reader, controller).catch(error => rewrite.fail(reader, controller, error));
        },
        async pull(controller) {
          if (buffered instanceof Uint8Array) return;
          try { await rewrite.pull(reader, controller); }
          catch (error) {
            await rewrite.fail(reader, controller, error);
          }
        },
        async cancel(reason) { rewrite.close(); await reader?.cancel(reason); },
      });
    }
    async fail(reader: ReadableStreamDefaultReader<Uint8Array> | undefined, controller: ReadableStreamDefaultController<Uint8Array>, error: unknown) {
      this.close();
      controller.error(error);
      try { await reader?.cancel(error); } catch {}
    }
    async buffered(bytes: Uint8Array, reader: ReadableStreamDefaultReader<Uint8Array> | undefined, controller: ReadableStreamDefaultController<Uint8Array>) {
      reader?.read().catch(error => this.fail(reader, controller, error));
      await this.asyncStep(native.htmlStep(this.id, "write", bytes), controller);
      if (this.closed) return;
      await this.asyncStep(native.htmlStep(this.id, "end", empty), controller);
      if (this.closed) return;
      this.close();
      controller.close();
    }
    async pull(reader: ReadableStreamDefaultReader<Uint8Array> | undefined, controller: ReadableStreamDefaultController<Uint8Array>) {
      if (this.closed) return;
      const chunk = await reader?.read();
      if (this.closed) return;
      if (!chunk || chunk.done) {
        await this.asyncStep(native.htmlStep(this.id, "end", empty), controller);
        if (this.closed) return;
        this.close();
        controller.close();
        return;
      }
      const bytes = typeof chunk.value === "string" ? encoder.encode(chunk.value) : chunk.value;
      await this.asyncStep(native.htmlStep(this.id, "write", bytes), controller);
    }
  }

  function registration(selector: string | null, value: unknown): Registration {
    if ((typeof value !== "object" || value === null) && typeof value !== "function") throw new TypeError("Expected object");
    const handlers: Partial<Record<Kind, Callback>> = {};
    const kinds: Kind[] = selector === null ? ["doctype", "comments", "text", "end"] : ["element", "comments", "text"];
    for (const kind of kinds) {
      const callback: unknown = Reflect.get(value, kind);
      if (callback == null) continue;
      if (typeof callback !== "function") throw new TypeError(`${kind} must be a function`);
      handlers[kind] = function (token) { return Reflect.apply(callback, this, [token]); };
    }
    return { selector, receiver: value, handlers };
  }

  class HTMLRewriter {
    #registrations: Registration[] = [];
    on(selector: unknown, handlers: unknown) {
      if (selector == null) throw new TypeError("Expected string");
      const pattern = domString(selector);
      native.htmlValidateSelector(pattern);
      this.#registrations.push(registration(pattern, handlers));
      return this;
    }
    onDocument(handlers: unknown) { this.#registrations.push(registration(null, handlers)); return this; }
    transform(input: unknown) {
      if (input instanceof Response) {
        if (input.bodyUsed) throw new TypeError("Response body already used");
        const rewrite = new Rewrite(this.#registrations.slice());
        const headers = new Headers(input.headers);
        const body = rewrite.stream(input);
        const output = input.type === "error" ? Response.error() : new Response(body, { status: input.status, statusText: input.statusText, headers });
        if (input.type === "error") {
          Reflect.set(output, "_stream", body);
          for (const [name, value] of headers) output.headers.set(name, value);
        }
        internal.web.Response._setUrl(output, input.url);
        return output;
      }
      if (typeof input === "string") return new TextDecoder().decode(new Rewrite(this.#registrations.slice()).sync(encoder.encode(input)));
      if (input instanceof ArrayBuffer) return new Rewrite(this.#registrations.slice()).sync(new Uint8Array(input)).buffer;
      if (ArrayBuffer.isView(input)) return new Rewrite(this.#registrations.slice()).sync(new Uint8Array(input.buffer, input.byteOffset, input.byteLength)).buffer;
      throw new TypeError("Expected Response or Body");
    }
  }
  Object.defineProperty(HTMLRewriter.prototype, Symbol.toStringTag, { value: "HTMLRewriter", configurable: true });
  return { HTMLRewriter };
})
