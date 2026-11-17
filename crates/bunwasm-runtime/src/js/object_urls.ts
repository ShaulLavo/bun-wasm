(function (internal: BunWasm.Internal & { web: { Blob: typeof Blob; File: typeof File } }) {
  "use strict";
  const { Blob: BlobCtor, File: FileCtor } = internal.web;
  const blobs = new Map<string, Blob>();
  const typeGetter = getter(BlobCtor.prototype, "type");
  const nameGetter = getter(FileCtor.prototype, "name");
  const modifiedGetter = getter(FileCtor.prototype, "lastModified");
  const bytesOf = intrinsicBytes(BlobCtor.prototype);
  const stringValue = String.prototype.valueOf;

  function getter(prototype: object, name: string) {
    const get = Object.getOwnPropertyDescriptor(prototype, name)?.get;
    if (!get) throw new Error(`Missing intrinsic ${name} getter`);
    return get;
  }

  function intrinsicBytes(prototype: object): (this: Blob) => Uint8Array {
    const read: unknown = Object.getOwnPropertyDescriptor(prototype, "_intrinsicBytes")?.value;
    if (typeof read !== "function") throw new Error("Missing intrinsic Blob bytes reader");
    return read as (this: Blob) => Uint8Array;
  }

  function fileMetadata(blob: Blob): { name: string; lastModified: number } | undefined {
    try { return { name: nameGetter.call(blob), lastModified: modifiedGetter.call(blob) }; }
    catch { return undefined; }
  }

  // A view when the bytes already sit in an ArrayBuffer; a shared buffer is copied once.
  function blobPart(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
    const { buffer } = bytes;
    if (buffer instanceof ArrayBuffer) return new Uint8Array(buffer, bytes.byteOffset, bytes.byteLength);
    return new Uint8Array(bytes);
  }

  // The bytes come from the Blob's own brand, never from its public prototype.
  function clone(blob: Blob): Blob {
    const type: string = typeGetter.call(blob);
    const bytes = blobPart(bytesOf.call(blob));
    const file = fileMetadata(blob);
    if (file) return new FileCtor([bytes], file.name, { type, lastModified: file.lastModified });
    return new BlobCtor([bytes], { type });
  }

  function invalidArgument(message: string) {
    return Object.assign(new TypeError(message), { code: "ERR_INVALID_ARG_TYPE" });
  }

  function createObjectURL(blob: Blob) {
    try { typeGetter.call(blob); }
    catch { throw invalidArgument("createObjectURL expects a Blob object"); }
    const snapshot = clone(blob);
    const url = "blob:" + internal.randomUUID();
    blobs.set(url, snapshot);
    return url;
  }

  function key(input: unknown) {
    const value = `${input}`;
    // UUID object URLs have a fixed length. Reject long inputs before Map hashes them.
    return value.length === 41 && value.startsWith("blob:") ? value : undefined;
  }

  function resolveObjectURL(input: unknown) {
    const url = key(input);
    const blob = url === undefined ? undefined : blobs.get(url);
    return blob === undefined ? undefined : clone(blob);
  }

  function revokeObjectURL(input: unknown) {
    if (arguments.length === 0) {
      throw Object.assign(new TypeError("Not enough arguments to 'revokeObjectURL'. Expected 1, got 0."), { code: "ERR_MISSING_ARGS" });
    }
    try { stringValue.call(input); }
    catch { throw invalidArgument("revokeObjectURL expects a string"); }
    const url = key(input);
    if (url !== undefined) blobs.delete(url);
  }

  return { createObjectURL, resolveObjectURL, revokeObjectURL };
})
