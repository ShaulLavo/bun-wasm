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
    return new ReadableStream({
      type: "bytes",
      pull(controller: ReadableByteStreamController) {
        if (done) { controller.close(); return; }
        return new Promise<void>((resolve, reject) => {
          function fail(error: unknown): void {
            finish();
            reject(options.signal?.aborted ? options.signal.reason : error);
          }
          options.addWaiter({
            step() {
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
            },
            fail,
          });
        });
      },
      cancel: finish,
    });
  }
  return { stream };
})
