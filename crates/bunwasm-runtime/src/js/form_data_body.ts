// FormData bodies, ported from Bun: parsing follows
// src/runtime/webcore/FormData.rs (`for_each_multipart_entry`) and
// src/bun_core/util.rs (`form_data::Encoding::get`, `get_boundary`);
// serializing follows src/runtime/webcore/Blob.rs (`from_dom_form_data`).
// Record: docs/bun-patches/form-data-body.md.
(function (internal: BunWasm.Internal) {
  "use strict";
  const native = internal.native;
  type Encoding = BunWasm.FormDataEncoding;
  type Deps = BunWasm.FormDataBodyDeps;
  type Bytes = Uint8Array<ArrayBuffer>;
  type Field = { name: Bytes; value: Bytes; filename: Bytes | null; contentType: Bytes | null };
  type Fail = (reason: string) => Error;

  const CRLF = native.utf8Encode("\r\n");
  const HEADER_END = native.utf8Encode("\r\n\r\n");
  const DASHES = native.utf8Encode("--");
  const FORM_DATA = native.utf8Encode("form-data;");
  const UTF8_BOM = [0xef, 0xbb, 0xbf];
  const [CR, LF, QUOTE, BACKSLASH, SEMICOLON, EQUALS, COLON] = [13, 10, 34, 92, 59, 61, 58];
  // Bun formats `--{boundary}--` into a 76-byte stack buffer.
  const BOUNDARY_BUFFER = 76;
  // Bun's `MimeType::sniff`, used when a file part has no type or known extension.
  const IMAGE_HEADERS: [number[], string][] = [
    [[0x42, 0x4d], "image/bmp"],
    [[0xff, 0xd8, 0xff], "image/jpeg"],
    [[0x49, 0x49, 0x2a, 0x00], "image/tiff"],
    [[0x4d, 0x4d, 0x00, 0x2a], "image/tiff"],
    [[0x47, 0x49, 0x46, 0x38, 0x39, 0x61], "image/gif"],
    [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "image/png"],
  ];

  function startsWith(haystack: Uint8Array, needle: ArrayLike<number>, at = 0): boolean {
    if (at + needle.length > haystack.length) return false;
    for (let i = 0; i < needle.length; i++) if (haystack[at + i] !== needle[i]) return false;
    return true;
  }

  // Typed-array indexOf finds candidates natively; only those get compared.
  function indexOf(haystack: Uint8Array, needle: Uint8Array, from = 0): number {
    const first = needle[0]!;
    const last = haystack.length - needle.length;
    for (let at = haystack.indexOf(first, from); at !== -1 && at <= last; at = haystack.indexOf(first, at + 1)) {
      if (startsWith(haystack, needle, at)) return at;
    }
    return -1;
  }

  function lastIndexOf(haystack: Uint8Array, needle: Uint8Array): number {
    const first = needle[0]!;
    let at = haystack.length - needle.length;
    while (at >= 0) {
      at = haystack.lastIndexOf(first, at);
      if (at === -1 || startsWith(haystack, needle, at)) return at;
      at--;
    }
    return -1;
  }

  function split(input: Bytes, separator: Uint8Array): Bytes[] {
    const pieces: Bytes[] = [];
    let start = 0;
    for (let at = indexOf(input, separator); at !== -1; at = indexOf(input, separator, start)) {
      pieces.push(input.subarray(start, at));
      start = at + separator.length;
    }
    pieces.push(input.subarray(start));
    return pieces;
  }

  function trim(bytes: Bytes, set: string): Bytes {
    let start = 0;
    let end = bytes.length;
    while (start < end && set.includes(String.fromCharCode(bytes[start]!))) start++;
    while (end > start && set.includes(String.fromCharCode(bytes[end - 1]!))) end--;
    return bytes.subarray(start, end);
  }

  // ASCII case-insensitive equality against a lowercase literal.
  function asciiEquals(bytes: Uint8Array, lowercase: string): boolean {
    if (bytes.length !== lowercase.length) return false;
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i]!;
      if ((b >= 65 && b <= 90 ? b + 32 : b) !== lowercase.charCodeAt(i)) return false;
    }
    return true;
  }

  function withoutBom(bytes: Bytes): Bytes {
    return startsWith(bytes, UTF8_BOM) ? bytes.subarray(3) : bytes;
  }

  function unquotedSemicolon(text: string): number {
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c === '"') quoted = !quoted;
      else if (c === "\\" && quoted) i++;
      else if (c === ";" && !quoted) return i;
    }
    return -1;
  }

  // Bun's `get_boundary`: the parameter named exactly `boundary` after an unquoted `;`.
  function boundaryOf(contentType: string): string | null {
    let rest = contentType;
    for (let semi = unquotedSemicolon(rest); semi !== -1; semi = unquotedSemicolon(rest)) {
      rest = rest.slice(semi + 1);
      const param = rest.replace(/^[ \t]+/, "");
      const eq = param.indexOf("=");
      if (eq === -1 || param.slice(0, eq).toLowerCase() !== "boundary") continue;
      const begin = param.slice(eq + 1);
      if (begin === "") return null;
      const end = begin.includes(";") ? begin.indexOf(";") : begin.length;
      if (begin[0] !== '"') return begin.slice(0, end);
      return end > 1 && begin[end - 1] === '"' ? begin.slice(1, end - 1) : null;
    }
    return null;
  }

  // Bun's `form_data::Encoding::get`; null when the body cannot be decoded as a form.
  function encoding(contentType: string | null | undefined): Encoding | null {
    const type = String(contentType ?? "");
    const lower = type.toLowerCase();
    if (lower.includes("application/x-www-form-urlencoded")) return { kind: "urlencoded" };
    if (!lower.includes("multipart/form-data")) return null;
    const boundary = boundaryOf(type);
    return boundary === null ? null : { kind: "multipart", boundary: native.utf8Encode(boundary) };
  }

  // A `name`/`filename` value: up to the closing quote (or the end), keeping
  // `\"` escapes as written. Returns the value and the bytes after it.
  function dispositionValue(value: Bytes): [Bytes, Bytes] {
    let i = 0;
    for (; i < value.length; i++) {
      if (value[i] === QUOTE) return [value.subarray(0, i), value.subarray(i + 1)];
      if (value[i] === BACKSLASH && value[i + 1] === QUOTE) i++;
    }
    return [value, value.subarray(value.length)];
  }

  function readDisposition(line: Bytes, field: Field): void {
    let value = trim(line, " \t");
    if (value.length >= FORM_DATA.length && asciiEquals(value.subarray(0, FORM_DATA.length), "form-data;")) {
      value = trim(value.subarray(FORM_DATA.length), " \t");
    }
    for (let eq = value.indexOf(EQUALS); eq !== -1; eq = value.indexOf(EQUALS)) {
      const key = trim(value.subarray(0, eq), " \t;");
      value = value.subarray(eq + 1);
      if (value[0] === QUOTE) value = value.subarray(1);
      const [fieldValue, rest] = dispositionValue(value);
      value = rest;
      if (asciiEquals(key, "name")) field.name = fieldValue;
      else if (asciiEquals(key, "filename")) field.filename = fieldValue;
      if (field.name.length > 0 && field.filename) return;
      const semi = value.indexOf(SEMICOLON);
      if (semi === -1) return;
      value = value.subarray(semi + 1);
    }
  }

  function readContentType(value: Bytes, field: Field): void {
    const trimmed = trim(value, "; \t");
    // A bare CR or LF must not reach a Blob type that is later sent as a header.
    if (trimmed.every(b => b === 9 || (b >= 0x20 && b <= 0x7e))) field.contentType = trimmed;
  }

  function readField(chunk: Bytes, fail: Fail): Field | null {
    const headerEnd = indexOf(chunk, HEADER_END);
    if (headerEnd === -1) throw fail("is missing header end");
    let headers = chunk.subarray(0, headerEnd + 2);
    const field: Field = { name: new Uint8Array(0), value: chunk.subarray(headerEnd + 4), filename: null, contentType: null };
    while (headers.length > 0 && (!field.filename || field.name.length === 0)) {
      const lineEnd = indexOf(headers, CRLF);
      if (lineEnd === -1) throw fail("is missing header line end");
      const line = headers.subarray(0, lineEnd);
      headers = headers.subarray(lineEnd + 2);
      const colon = line.indexOf(COLON);
      if (colon === -1) throw fail("is missing header colon separator");
      const key = line.subarray(0, colon);
      const value = line.subarray(colon + 1);
      if (asciiEquals(key, "content-disposition")) readDisposition(value, field);
      else if (value.length > 0 && !field.contentType && asciiEquals(key, "content-type")) readContentType(value, field);
    }
    if (field.name.length === 0) return null;
    const size = field.value.length;
    if (size >= 2 && field.value[size - 2] === CR && field.value[size - 1] === LF) field.value = field.value.subarray(0, size - 2);
    return field;
  }

  function multipartFields(input: Bytes, boundary: Uint8Array, fail: Fail): Field[] {
    if (boundary.length + 4 > BOUNDARY_BUFFER) throw fail("boundary is too long");
    const end = lastIndexOf(input, internal.concatBytes([DASHES, boundary, DASHES]));
    if (end === -1) throw fail("missing final boundary");
    // The piece before the first separator is the preamble.
    const parts = split(input.subarray(0, end), internal.concatBytes([DASHES, boundary, CRLF])).slice(1);
    const fields: Field[] = [];
    for (const part of parts) {
      const field = readField(part, fail);
      if (field) fields.push(field);
    }
    return fields;
  }

  function sniff(bytes: Uint8Array): string {
    if (bytes.length < 2) return "";
    return IMAGE_HEADERS.find(([header]) => startsWith(bytes, header))?.[1] ?? "";
  }

  // Bun's `bun_paths::extension`: after the basename's last dot, unless the dot leads it.
  function extensionOf(filename: string): string {
    const base = filename.slice(filename.lastIndexOf("/") + 1);
    const dot = base.lastIndexOf(".");
    return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
  }

  function fileType(field: Field, filename: string, deps: Deps): string {
    if (field.contentType) return native.utf8Decode(field.contentType);
    const extension = extensionOf(filename);
    return (extension && deps.mimeByExtension(extension)) || sniff(field.value);
  }

  function parse(bytes: Bytes, kind: Encoding, deps: Deps, fail: Fail): FormData {
    const form = new deps.FormData();
    if (kind.kind === "urlencoded") {
      for (const [name, value] of new deps.URLSearchParams(native.utf8Decode(withoutBom(bytes)))) form.append(name, value);
      return form;
    }
    for (const field of multipartFields(bytes, kind.boundary, fail)) {
      const name = native.utf8Decode(field.name);
      if (!field.filename) {
        form.append(name, native.utf8Decode(withoutBom(field.value)));
        continue;
      }
      const filename = native.utf8Decode(field.filename);
      form.append(name, new deps.File([field.value], filename, { type: fileType(field, filename, deps) }));
    }
    return form;
  }

  // WHATWG multipart/form-data encoding: names and string values get CRLF
  // newlines; names and filenames percent-encode `"`, CR and LF.
  function component(text: string, kind: "name" | "value" | "filename"): string {
    const normalized = kind === "filename" ? text : text.replace(/\r\n|\r|\n/g, "\r\n");
    if (kind === "value") return normalized;
    return normalized.replace(/["\r\n]/g, c => (c === '"' ? "%22" : c === "\r" ? "%0D" : "%0A"));
  }

  function serialize(form: FormData, deps: Deps): { bytes: Uint8Array; type: string } {
    const random = Array.from(native.randomBytes(16), b => b.toString(16).padStart(2, "0")).join("");
    const boundary = `----WebKitFormBoundary${random}`;
    const chunks: Uint8Array[] = [];
    for (const [name, value] of deps.FormData.prototype.entries.call(form)) {
      const head = `--${boundary}\r\nContent-Disposition: form-data; name="${component(name, "name")}"`;
      if (typeof value === "string") {
        chunks.push(native.utf8Encode(`${head}\r\n\r\n${component(value, "value")}\r\n`));
        continue;
      }
      const type = value.type && !/[\r\n]/.test(value.type) ? value.type : "application/octet-stream";
      const fileHead = `${head}; filename="${component(value.name, "filename")}"\r\nContent-Type: ${type}\r\n\r\n`;
      chunks.push(native.utf8Encode(fileHead), deps.blobBytes(value), CRLF);
    }
    chunks.push(native.utf8Encode(`--${boundary}--\r\n`));
    return { bytes: internal.concatBytes(chunks), type: `multipart/form-data; boundary=${boundary}` };
  }

  return { encoding, parse, serialize };
})
