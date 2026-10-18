(function () {
  type Pair = [string, string];
  type Connection = {
    closed: boolean;
    onClose?: (() => void) | null;
    onEnd?: (() => void) | null;
    write(bytes: Uint8Array, callback?: (error?: unknown) => void): void;
    destroy(error?: unknown): void;
  };
  type BodyResponse = Response & {
    _body: Uint8Array | null;
    _stream: ReadableStream<unknown> | null;
    _bodyUsed: boolean;
  };
  type Serialize = (status: number, message: string, headers: Pair[]) => Uint8Array;
  const encoder = new TextEncoder();
  const crlf = encoder.encode("\r\n");
  const terminal = encoder.encode("0\r\n\r\n");

  function headers(response: Response, keepAlive: boolean): Pair[] {
    const pairs = Array.from(response.headers).filter(([name]) => name !== "content-length" && name !== "transfer-encoding");
    if (!response.headers.has("date")) pairs.push(["date", new Date().toUTCString()]);
    if (!keepAlive) pairs.push(["connection", "close"]);
    return pairs;
  }

  function write(connection: Connection, bytes: Uint8Array): Promise<void> {
    return new Promise((resolve, reject) => connection.write(bytes, error => error ? reject(error) : resolve()));
  }

  function chunkBytes(value: unknown): Uint8Array {
    if (typeof value === "string") return encoder.encode(value);
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    throw new TypeError("Expected a string, ArrayBuffer or ArrayBufferView in the response body");
  }

  async function writeChunk(connection: Connection, bytes: Uint8Array): Promise<void> {
    if (!bytes.length) return;
    await write(connection, encoder.encode(`${bytes.length.toString(16)}\r\n`));
    await write(connection, bytes);
    await write(connection, crlf);
  }

  async function stream(connection: Connection, response: BodyResponse, source: ReadableStream<unknown>, pairs: Pair[], serialize: Serialize, reportError: (error: unknown) => void): Promise<boolean> {
    if (response.bodyUsed || source.locked) throw new TypeError("Body already used");
    const reader = source.getReader();
    const previousClose = connection.onClose;
    const previousEnd = connection.onEnd;
    const closed = () => {
      previousClose?.();
      void reader.cancel().catch(reportError);
    };
    const ended = () => {
      previousEnd?.();
      connection.destroy();
    };
    connection.onClose = closed;
    connection.onEnd = ended;
    response._bodyUsed = true;
    pairs.push(["transfer-encoding", "chunked"]);
    try {
      await write(connection, serialize(response.status, response.statusText, pairs));
      while (!connection.closed) {
        const result = await reader.read();
        if (result.done) break;
        await writeChunk(connection, chunkBytes(result.value));
      }
      if (connection.closed) return false;
      await write(connection, terminal);
      return true;
    } catch (error) {
      reportError(error);
      connection.destroy(error);
      return false;
    } finally {
      if (connection.onClose === closed) connection.onClose = previousClose;
      if (connection.onEnd === ended) connection.onEnd = previousEnd;
      reader.releaseLock();
    }
  }

  async function writeResponse(connection: Connection, response: BodyResponse, method: string, keepAlive: boolean, serialize: Serialize, reportError: (error: unknown) => void): Promise<boolean> {
    const pairs = headers(response, keepAlive);
    const bodyless = response.status === 204 || response.status === 304;
    const source = response._body === null ? response._stream : null;
    if (source && method !== "HEAD" && !bodyless) return await stream(connection, response, source, pairs, serialize, reportError) && keepAlive;
    const body = method === "HEAD" || bodyless ? new Uint8Array(0) : new Uint8Array(await response.arrayBuffer());
    if (!bodyless) pairs.push(["content-length", String(method === "HEAD" ? Number(response.headers.get("content-length") || 0) : body.length)]);
    connection.write(serialize(response.status, response.statusText, pairs));
    if (!bodyless && body.length) connection.write(body);
    if (source && !source.locked) void source.cancel().catch(reportError);
    return keepAlive;
  }
  return { writeResponse };
})
