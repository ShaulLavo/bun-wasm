class ReadableStreamIterator implements AsyncIterableIterator<unknown> {
  #reader: ReadableStreamDefaultReader<unknown>;
  #preventCancel: boolean;
  #finished = false;
  #ongoing: Promise<void> = Promise.resolve();

  constructor(reader: ReadableStreamDefaultReader<unknown>, preventCancel: boolean) {
    this.#reader = reader;
    this.#preventCancel = preventCancel;
  }

  async next(): Promise<IteratorResult<unknown>> {
    return this.#queue(() => this.#next());
  }

  async return(value?: unknown): Promise<IteratorResult<unknown>> {
    return this.#queue(() => this.#return(value));
  }

  [Symbol.asyncIterator]() {
    return this;
  }

  #queue(operation: () => Promise<IteratorResult<unknown>>) {
    const result = this.#ongoing.then(operation);
    this.#ongoing = result.then(() => undefined, () => undefined);
    return result;
  }

  #finish() {
    this.#finished = true;
    this.#reader.releaseLock();
  }

  async #next(): Promise<IteratorResult<unknown>> {
    if (this.#finished) return { done: true, value: undefined };
    try {
      const result = await this.#reader.read();
      if (result.done) this.#finish();
      return { done: Boolean(result.done), value: result.value };
    } catch (error) {
      this.#finish();
      throw error;
    }
  }

  async #return(value: unknown): Promise<IteratorResult<unknown>> {
    if (this.#finished) return { done: true, value };
    this.#finished = true;
    try {
      if (!this.#preventCancel) await this.#reader.cancel(value);
    } finally {
      this.#reader.releaseLock();
    }
    return { done: true, value };
  }
}

function lockedGetter(prototype: object): () => unknown {
  for (let current: object | null = prototype; current; current = Object.getPrototypeOf(current)) {
    const descriptor = Object.getOwnPropertyDescriptor(current, "locked");
    if (descriptor?.get) return descriptor.get;
  }
  throw new TypeError("ReadableStream locked getter missing");
}

function preventCancelOption(options: unknown): boolean {
  if (options === undefined || options === null) return false;
  if (typeof options !== "object" && typeof options !== "function") throw new TypeError("ReadableStream iteration options must be a dictionary");
  return Boolean(Reflect.get(options, "preventCancel"));
}

function iterationMethod(prototype: ReadableStream<unknown>) {
  const getReader: (this: unknown) => ReadableStreamDefaultReader<unknown> = prototype.getReader;
  const getLocked = lockedGetter(prototype);
  return {
    values(this: unknown, options: unknown = undefined) {
      Reflect.apply(getLocked, this, []);
      const preventCancel = preventCancelOption(options);
      return new ReadableStreamIterator(getReader.call(this), preventCancel);
    },
  }.values;
}

export function installReadableStreamIteration(Ctor: typeof ReadableStream): void {
  const prototype = Ctor.prototype;
  const values: unknown = Reflect.get(prototype, "values");
  const alias: unknown = Reflect.get(prototype, Symbol.asyncIterator);
  if (typeof values === "function" && typeof alias === "function") return;
  const method = typeof values === "function" ? values : typeof alias === "function" ? alias : iterationMethod(prototype);
  const descriptor = { configurable: true, enumerable: true, writable: true, value: method };
  if (typeof values !== "function") Object.defineProperty(prototype, "values", descriptor);
  if (typeof alias !== "function") Object.defineProperty(prototype, Symbol.asyncIterator, descriptor);
}
