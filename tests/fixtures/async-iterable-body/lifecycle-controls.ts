export async function lifecycleControls() {
  const rows: unknown[] = [];
  const pause = () => new Promise(resolve => setTimeout(resolve, 20));
  async function bounded(promise: Promise<unknown>) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("lifecycle control exceeded 1000ms")), 1000);
      })]);
    } finally { clearTimeout(timer); }
  }
  async function record(name: string, action: () => Promise<unknown>) {
    try { rows.push([name, await action()]); }
    catch (error) { rows.push([name, { error: String(error) }]); }
  }
  await record("acquisition", async () => {
    const events: string[] = [];
    let index = 0;
    const body = {
      get [Symbol.asyncIterator]() {
        events.push("get");
        return function () { events.push(`receiver:${this === body}`); return this; };
      },
      async next() { events.push("next"); return { done: index++ > 0, value: "a" }; },
    };
    const response = new Response(body);
    const constructed = events.slice();
    await pause();
    const idle = events.slice();
    const text = await response.text();
    return { constructed, idle, text, events };
  });
  await record("next-validation", async () => {
    const events: string[] = [];
    let index = 0;
    const producer = {
      get next() {
        events.push("get-next");
        return async function () { events.push(`next:${this === producer}`); return { done: index++ > 0, value: "a" }; };
      },
    };
    const source = { [Symbol.asyncIterator]() { events.push("iterator"); return producer; } };
    const response = new Response(source);
    const constructed = events.slice();
    await pause();
    const idle = events.slice();
    const text = await response.text();
    return { constructed, idle, text, events };
  });
  await record("next-replaced", async () => {
    const events: string[] = [];
    let index = 0;
    const producer = {
      get next() {
        events.push("get-next");
        return async function () { events.push(`next:${this === producer}`); return { done: index++ > 0, value: "a" }; };
      },
    };
    const source = { [Symbol.asyncIterator]() { events.push("iterator"); return producer; } };
    const response = new Response(source);
    const constructed = events.slice();
    Object.defineProperty(producer, "next", { get() { throw new Error("next replaced"); } });
    await pause();
    const idle = events.slice();
    const text = await response.text();
    return { constructed, idle, text, events };
  });
  await record("next-getter-error", async () => {
    const marker = new Error("next getter");
    const source = { [Symbol.asyncIterator]() { return { get next() { throw marker; } }; } };
    try { new Response(source); return "missing"; }
    catch (error) { return { original: error === marker }; }
  });
  await record("invalid-producers", async () => {
    const rows = [];
    for (const producer of [null, 0, {}, { next: 0 }]) {
      try { new Response({ [Symbol.asyncIterator]() { return producer; } }); rows.push("missing"); }
      catch (error) { rows.push(error instanceof TypeError); }
    }
    return rows;
  });
  await record("one-getter", async () => {
    let gets = 0;
    let index = 0;
    const marker = new Error("second getter");
    const body = {
      get [Symbol.asyncIterator]() {
        if (++gets > 1) throw marker;
        return function () { return this; };
      },
      async next() { return { done: index++ > 0, value: "ok" }; },
    };
    const response = new Response(body);
    try { return { text: await response.text(), gets }; }
    catch (error) { return { original: error === marker, gets }; }
  });
  await record("getter-error", async () => {
    const marker = new Error("getter");
    try { new Response({ get [Symbol.asyncIterator]() { throw marker; } }); return "missing"; }
    catch (error) { return { original: error === marker }; }
  });
  await record("promise-chunk", async () => {
    let index = 0;
    const source = { [Symbol.asyncIterator]() { return this; }, async next() { return { done: index++ > 0, value: Promise.resolve("ok") }; } };
    return new Response(source).text();
  });
  await record("thenable-chunk", async () => {
    let gets = 0;
    let receiver = false;
    const chunk = { get then() { gets++; return function (resolve: (value: string) => void) { receiver = this === chunk; resolve("ok"); }; } };
    let index = 0;
    const source = { [Symbol.asyncIterator]() { return this; }, async next() { return { done: index++ > 0, value: chunk }; } };
    try { return { text: await new Response(source).text(), gets, receiver }; }
    catch (error) { return { error: String(error), gets, receiver }; }
  });
  await record("offsets", async () => {
    const bytes = new Uint8Array([88, 97, 98, 89]);
    async function* chunks() { yield bytes.subarray(1, 3); yield new DataView(bytes.buffer, 1, 2); yield bytes.buffer.slice(1, 3); }
    return new Response(chunks()).text();
  });
  await record("snapshot", async () => {
    const bytes = new Uint8Array([97]);
    async function* chunks() { yield bytes; bytes[0] = 98; yield bytes; }
    return new Response(chunks()).text();
  });
  await record("falsy-errors", async () => {
    const results = [];
    for (const marker of [undefined, null, false, 0, ""]) {
      async function* chunks() { yield "a"; throw marker; }
      try { await new Response(chunks()).text(); results.push("missing"); }
      catch (error) { results.push(Object.is(error, marker)); }
    }
    return results;
  });
  await record("invalid-cleanup", async () => {
    const events: string[] = [];
    const source = { [Symbol.asyncIterator]() { return this; }, async next() { return { done: false, value: 42 }; }, async return() { events.push("return"); return { done: true }; } };
    try { await new Response(source).text(); return "missing"; }
    catch (error) { return { type: error instanceof TypeError, events }; }
  });
  await record("pending-cancel", async () => {
    const events: string[] = [];
    let release = () => {};
    const pending = new Promise(resolve => { release = () => resolve({ done: false, value: "a" }); });
    const producer = {
      next() { events.push("next"); return pending; },
      async return() { events.push("return"); return { done: true }; },
    };
    const source = { [Symbol.asyncIterator]() { return producer; } };
    const response = new Response(source);
    const reader = response.body!.getReader();
    let read: Promise<ReadableStreamReadResult<unknown>> | undefined;
    let cancel: Promise<unknown> | undefined;
    let beforeRelease;
    try {
      read = reader.read();
      await pause();
      cancel = reader.cancel("stop");
      let state = "pending";
      void cancel.then(() => { state = "resolved"; }, () => { state = "rejected"; });
      await pause();
      beforeRelease = { events: events.slice(), state };
    } finally {
      release();
      try { await bounded(Promise.allSettled([read, cancel])); }
      finally { reader.releaseLock(); }
    }
    return { beforeRelease, events, readDone: (await read)?.done, locked: response.body!.locked };
  });
  await record("clone-lock", async () => {
    let pulled = 0;
    async function* chunks() { for (let i = 0; i < 4; i++) { pulled++; yield String(i); } }
    const response = new Response(chunks());
    const reader = response.body!.getReader();
    let lockedClone = "allowed";
    try { response.clone(); } catch (error) { lockedClone = error instanceof TypeError ? "TypeError" : String(error); }
    reader.releaseLock();
    const clone = response.clone();
    const first = await response.text();
    const second = await clone.text();
    return { lockedClone, first, second, pulled };
  });
  await record("cancel-without-read", async () => {
    const events: string[] = [];
    const producer = {
      async next() { events.push("next"); return { done: false, value: "a" }; },
      async return() { events.push(`return:${this === producer}`); return { done: true }; },
    };
    const source = { [Symbol.asyncIterator]() { events.push(`iterator:${this === source}`); return producer; } };
    const response = new Response(source);
    await response.body!.cancel();
    return events;
  });
  await record("acquisition-throw", async () => {
    const marker = new Error("iterator acquisition failed");
    const source = { [Symbol.asyncIterator]() { throw marker; } };
    let response;
    try { response = new Response(source); }
    catch (error) { return { phase: "constructor", original: error === marker }; }
    try { await response.text(); return "missing"; }
    catch (error) { return { phase: "read", original: error === marker }; }
  });
  await record("return-errors", async () => {
    const results = [];
    for (const marker of [undefined, null, false, 0, ""]) {
      const source = { [Symbol.asyncIterator]() { return this; }, async next() { return { done: false, value: "a" }; }, async return() { throw marker; } };
      const reader = new Response(source).body!.getReader();
      await reader.read();
      try { await reader.cancel(); results.push("missing"); }
      catch (error) { results.push(Object.is(error, marker)); }
      reader.releaseLock();
    }
    return results;
  });
  return rows;
}
