(function () {
  type Waiter = { step(): boolean; fail(error: unknown): void };
  type Options = {
    handle: number;
    signal?: AbortSignal;
    onEnd?: () => void;
    read(handle: number): number | Uint8Array<ArrayBuffer>;
    error(handle: number, fallback: string): Error;
    addWaiter(waiter: Waiter): unknown;
    again: number;
  };
  function stream(options: Options): ReadableStream<Uint8Array> {
    let done = false;
    function finish(): void {
      if (done) return;
      done = true;
      options.onEnd?.();
    }
    function fail(error: unknown, reject: (reason: unknown) => void): void {
      finish();
      reject(options.signal?.aborted ? options.signal.reason : error);
    }
    function step(controller: ReadableByteStreamController, resolve: () => void, fail: (error: unknown) => void): boolean {
      if (done) { resolve(); return true; }
      if (options.signal?.aborted) { fail(options.signal.reason); return true; }
      const chunk = options.read(options.handle);
      if (chunk === options.again) return false;
      if (chunk === 0) {
        controller.close();
        if (controller.byobRequest) controller.byobRequest.respond(0);
        finish();
      } else if (typeof chunk === "number") {
        fail(options.error(options.handle, "network error while reading the body"));
      } else controller.enqueue(chunk);
      resolve();
      return true;
    }
    return new ReadableStream({
      type: "bytes",
      pull(controller: ReadableByteStreamController) {
        if (done) { controller.close(); return; }
        return new Promise<void>((resolve, reject) => {
          const failRead = (error: unknown) => fail(error, reject);
          options.addWaiter({ step: () => step(controller, resolve, failRead), fail: failRead });
        });
      },
      cancel: finish,
    });
  }
  return { stream };
})
