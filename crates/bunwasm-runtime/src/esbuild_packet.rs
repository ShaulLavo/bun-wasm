use std::borrow::Cow;

use sha2::{Digest, Sha256};

const SOURCE_SHA256: &str = "18b154677d0965c21748afe9b5f56fb11a664a9a6e21dd5fd5ecf9791384e700";
const READ: &str = "  read() {\n    let length = this.read32();";
const BORROW_STRING: &str = "  read(owned = true) {\n    let length = this.read32(); if (!owned && length >= 0 && length <= this.buf.length - this.ptr && Object.getPrototypeOf(this.buf) === Uint8Array.prototype && this.buf.constructor === Uint8Array.prototype.constructor && this.buf.constructor[Symbol.species] === this.buf.constructor && this.buf.buffer instanceof ArrayBuffer) { let ptr = this._read(length); return this.buf.subarray(ptr, ptr + length); }";

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

#[cfg(test)]
mod tests {
    use std::io::Read;

    use super::adapt;
    use crate::State;
    use crate::transpiler::{Loader, PassthroughTranspiler};

    #[test]
    fn state_preparation_adapts_the_published_module_before_transpilation() {
        let compressed = include_bytes!("../../../scripts/fixtures/esbuild-packet/main.js.gz");
        let mut source = String::new();
        flate2::read::GzDecoder::new(compressed.as_slice())
            .read_to_string(&mut source)
            .unwrap();
        let state = State::new(Vec::new(), Box::new(PassthroughTranspiler));
        let path = "/project/node_modules/esbuild/lib/main.js";
        let expected = adapt(&source, path);
        assert_ne!(expected, source);
        let prepared = state.prepare_javascript(&source, path, Loader::Js).unwrap();
        assert_eq!(prepared.code, expected);
        let unrelated = state
            .prepare_javascript(&source, "/project/main.js", Loader::Js)
            .unwrap();
        assert_eq!(unrelated.code, source);
    }
}
