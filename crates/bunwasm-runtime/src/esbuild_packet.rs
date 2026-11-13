use std::borrow::Cow;

use sha2::{Digest, Sha256};

const SOURCE_SHA256: &str = "18b154677d0965c21748afe9b5f56fb11a664a9a6e21dd5fd5ecf9791384e700";
const READ: &str = "  read() {\n    let length = this.read32();";
const BORROW_STRING: &str = "  read(owned = true) {\n    let length = this.read32(); if (!owned && length >= 0 && length <= this.buf.length - this.ptr && Object.getPrototypeOf(this.buf) === Uint8Array.prototype && this.buf.buffer instanceof ArrayBuffer) { let ptr = this._read(length); return this.buf.subarray(ptr, ptr + length); }";

pub(super) fn adapt<'a>(source: &'a str, path: &str) -> Cow<'a, str> {
    if !path.ends_with("/node_modules/esbuild/lib/main.js")
        && !path.ends_with("/node_modules/esbuild-wasm/lib/main.js")
    {
        return Cow::Borrowed(source);
    }
    if format!("{:x}", Sha256::digest(source.as_bytes())) != SOURCE_SHA256 {
        return Cow::Borrowed(source);
    }
    Cow::Owned(
        source
            .replacen(READ, BORROW_STRING, 1)
            .replace("decodeUTF8(bb.read())", "decodeUTF8(bb.read(false))"),
    )
}
