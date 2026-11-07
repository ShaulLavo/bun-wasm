import { installNativeStreamState } from "../src/native-stream-state";

const result: { done: boolean; error: string | null; checks: string[] } = { done: false, error: null, checks: [] };
Object.assign(globalThis, { nativeReadableIterationResult: result });
const closedKey = Symbol.for("nodejs.webstream.isClosedPromise");

function ensure(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function checkDescriptors(): void {
  const values = Object.getOwnPropertyDescriptor(ReadableStream.prototype, "values");
  const alias = Object.getOwnPropertyDescriptor(ReadableStream.prototype, Symbol.asyncIterator);
  ensure(typeof values?.value === "function" && alias?.value === values.value, "callable iterator aliases");
  for (const descriptor of [values, alias]) {
    ensure(descriptor?.configurable && descriptor.writable, "standard configurable descriptors");
  }
  ensure(values.enumerable && !alias?.enumerable, "Web IDL method and iterator enumerability");
  result.checks.push("callable aliases and configurable descriptors");
}

async function exercise(): Promise<void> {
  for (const key of ["values", Symbol.asyncIterator]) {
    ensure(Reflect.deleteProperty(ReadableStream.prototype, key), "remove host iteration");
    ensure(Reflect.get(ReadableStream.prototype, key) === undefined, "host method must be absent");
  }
  const dispose = installNativeStreamState();
  try {
    checkDescriptors();
    await readTrackedStream();
  } finally { dispose(); }
}

async function readTrackedStream(): Promise<void> {
  const promised = Promise.resolve("do not unwrap");
  const stream = new ReadableStream<unknown>({ start(controller) {
    controller.enqueue(promised);
    controller.enqueue("tail");
    controller.close();
  } });
  const completion: Promise<void> = Reflect.get(stream, closedKey).promise;
  const method: unknown = Reflect.get(stream, Symbol.asyncIterator);
  ensure(typeof method === "function", "missing iterator");
  const iterator: AsyncIterator<unknown> = Reflect.apply(method, stream, []);
  ensure(stream.locked, "iterator must acquire a reader immediately");
  const first = await iterator.next();
  ensure(!first.done && first.value === promised, "Promise chunk identity must survive");
  ensure((await iterator.next()).value === "tail", "stream order");
  ensure((await iterator.next()).done && !stream.locked, "EOF releases reader");
  await completion;
  result.checks.push("Promise chunks preserved", "tracked reader completion and lock release");
}

void exercise().catch(error => { result.error = String(error?.stack ?? error); }).finally(() => { result.done = true; });
