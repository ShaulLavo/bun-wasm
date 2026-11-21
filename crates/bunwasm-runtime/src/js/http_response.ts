(function () {
  type Pair = [string, string];
  type Connection = {
    closed: boolean;
    readEnded: boolean;
    onClose?: (() => void) | null;
    onEnd?: (() => void) | null;
    write(bytes: Uint8Array, callback?: (error?: unknown) => void): void;
    destroy(error?: unknown): void;
  };
  type BodyResponse = Response & {
    _body: Uint8Array | null;
    _stream: ReadableStream<unknown> | null;
    // A Bun.file() body: sent with the file's size as the Content-Length, streamed as read.
    _blob: (Blob & { _knownSize(): number | null }) | null;
    _bodyUsed: boolean;
    // What Bun.serve sends for a string or byte body without a Content-Type.
    _servedType: string | null;
  };
  type Serialize = (status: number, message: string, headers: Pair[]) => Uint8Array;
  const encoder = new TextEncoder();
  const crlf = encoder.encode("\r\n");
  const terminal = encoder.encode("0\r\n\r\n");

  function headers(response: BodyResponse, keepAlive: boolean): Pair[] {
    const pairs = Array.from(response.headers).filter(([name]) => name !== "content-length" && name !== "transfer-encoding");
    const served = response._servedType;
    if (served && (response._body?.length || response._blob) && !response.headers.has("content-type")) pairs.push(["content-type", served]);
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

  // Write the stream's bytes: chunked, or raw up to `length` when the length is known. Returns
  // whether the body went out complete; a source that ends short of `length` cannot.
  async function writeBody(connection: Connection, reader: ReadableStreamDefaultReader<unknown>, length: number | null): Promise<boolean> {
    let sent = 0;
    while (!connection.closed && (length === null || sent < length)) {
      const result = await reader.read();
      if (result.done) break;
      const bytes = chunkBytes(result.value);
      if (length === null) await writeChunk(connection, bytes);
      else if (bytes.length) await write(connection, bytes.subarray(0, length - sent));
      sent += bytes.length;
    }
    if (connection.closed) return false;
    if (length === null) {
      await write(connection, terminal);
      return true;
    }
    // A file that grew after its size was sent: the rest is not read.
    void reader.cancel().catch(() => {});
    return sent >= length;
  }

  async function stream(connection: Connection, response: BodyResponse, source: ReadableStream<unknown>, pairs: Pair[], serialize: Serialize, reportError: (error: unknown) => void, length: number | null = null): Promise<boolean> {
    if (response.bodyUsed || source.locked) throw new TypeError("Body already used");
    response._bodyUsed = true;
    if (connection.closed || connection.readEnded) {
      connection.destroy();
      void source.cancel().catch(reportError);
      return false;
    }
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
    pairs.push(length === null ? ["transfer-encoding", "chunked"] : ["content-length", String(length)]);
    try {
      await write(connection, serialize(response.status, response.statusText, pairs));
      if (await writeBody(connection, reader, length)) return true;
      // A body that ended short of its Content-Length leaves the connection unusable.
      if (!connection.closed) connection.destroy();
      return false;
    } catch (error) {
      reportError(error);
      connection.destroy(error);
      return false;
    } finally {
      if (connection.onClose === closed) connection.onClose = previousClose;
      if (connection.onEnd === ended) connection.onEnd = previousEnd;
      // The reader is kept, so the sent body's stream stays locked and used, as in Bun.
    }
  }

  // A Bun.file() body, or a stream over one, has the file's current size, or null when the file
  // cannot be stat'ed (that body is read whole, so the read reports the error).
  function fileSize(response: BodyResponse): number | null {
    if (!response._blob || response._body !== null) return null;
    const size = response._blob._knownSize();
    return size === null || !Number.isFinite(size) ? null : size;
  }

  // Bun sends a file body with its size as the Content-Length and its bytes as they are read,
  // so a large file is never held in memory whole. HEAD sends the size alone.
  async function sendFile(connection: Connection, response: BodyResponse, method: string, size: number, pairs: Pair[], serialize: Serialize, reportError: (error: unknown) => void): Promise<boolean> {
    if (method !== "HEAD") return stream(connection, response, response._stream ?? response._blob!.stream(), pairs, serialize, reportError, size);
    response._bodyUsed = true;
    pairs.push(["content-length", String(size)]);
    connection.write(serialize(response.status, response.statusText, pairs));
    const source = response._stream;
    if (source && !source.locked) void source.cancel().catch(reportError);
    return true;
  }

  async function writeResponse(connection: Connection, response: BodyResponse, method: string, keepAlive: boolean, serialize: Serialize, reportError: (error: unknown) => void): Promise<boolean> {
    const pairs = headers(response, keepAlive);
    const bodyless = response.status === 204 || response.status === 304;
    const size = bodyless ? null : fileSize(response);
    if (size !== null) return await sendFile(connection, response, method, size, pairs, serialize, reportError) && keepAlive;
    const source = response._body === null && !response._blob ? response._stream : null;
    if (source && method !== "HEAD" && !bodyless) return await stream(connection, response, source, pairs, serialize, reportError) && keepAlive;
    // An in-memory body is consumed even for HEAD, as in Bun: a stream its .body made
    // ends locked and disturbed, bodyUsed turns true, and its size is the Content-Length.
    const body = bodyless || source ? new Uint8Array(0) : new Uint8Array(await response.arrayBuffer());
    if (!bodyless) pairs.push(["content-length", String(method === "HEAD" ? Number(response.headers.get("content-length") || body.length) : body.length)]);
    connection.write(serialize(response.status, response.statusText, pairs));
    if (method !== "HEAD" && !bodyless && body.length) connection.write(body);
    if (source && !source.locked) void source.cancel().catch(reportError);
    return keepAlive;
  }
  return { writeResponse };
})
