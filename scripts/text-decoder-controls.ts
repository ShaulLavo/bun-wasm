import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";

const directory = resolve(import.meta.dir, "../crates/bunwasm-runtime/src/js");
const NativeDecoder = globalThis.TextDecoder;

type DecoderCodec = {
  decoder(label: string, fatal: boolean, ignoreBOM: boolean): { id: number; encoding: string };
  push(id: number, bytes: Uint8Array, last: boolean): string;
  release(id: number): void;
};

// Execute the complete production Web factory. Only its native codec boundary
// uses Bun's decoder here; the guest fixture exercises the Rust codec as well.
export function runtimeTextDecoder(codec?: DecoderCodec) {
  const handles = new Map<number, TextDecoder>();
  let next = 0;
  const native = {
    loadPolyfill(name: string): unknown {
      if (name === "web") return evaluate(readFileSync(process.env.BUN_WASM_TEXT_DECODER_WEB_SOURCE ?? resolve(directory, "web.js"), "utf8"));
      if (name === "text_decoder") return evaluate(readFileSync(resolve(directory, "text_decoder.ts"), "utf8"));
      if (name === "web_brand") return () => () => {};
      if (name === "streams") return () => ({ ReadableStream });
      if (name === "url_search_params" || name === "body_streams") return () => ({});
      throw new Error(`Unexpected module ${name}`);
    },
    platformInfo: { version: "control", arch: "control" },
    now: () => 0,
    timeOrigin: () => 0,
    utf8Decode: (bytes: Uint8Array, fatal: boolean) => new NativeDecoder("utf-8", { fatal, ignoreBOM: true }).decode(bytes),
    utf16leDecode: (bytes: Uint8Array) => Buffer.from(bytes).toString("utf16le"),
    latin1Decode: (bytes: Uint8Array) => Buffer.from(bytes).toString("latin1"),
    streams: codec ?? {
      decoder(label: string, fatal: boolean, ignoreBOM: boolean) {
        const decoder = new NativeDecoder(label, { fatal, ignoreBOM });
        const id = ++next;
        handles.set(id, decoder);
        return { id, encoding: decoder.encoding };
      },
      push(id: number, bytes: Uint8Array, last: boolean) {
        const decoder = handles.get(id);
        if (!decoder) throw new Error("Decoder handle is closed");
        return decoder.decode(bytes, { stream: !last });
      },
      release(id: number) { handles.delete(id); },
    },
  };
  const internal = { native };
  function evaluate(source: string) {
    return runInNewContext(new Bun.Transpiler({ loader: "ts" }).transformSync(`globalThis.__factory = ${source}`), {
      Uint8Array, ArrayBuffer, SharedArrayBuffer, FinalizationRegistry, TypeError, RangeError,
    });
  }
  const bootstrap = readFileSync(resolve(directory, "bootstrap.js"), "utf8");
  const start = bootstrap.indexOf("internal.require = function requirePolyfill(name) {");
  const end = bootstrap.indexOf("\n  };", start);
  if (start < 0 || end < start) throw new Error("Production polyfill loader not found");
  const loader = bootstrap.slice(start, end + "\n  };".length);
  const load: (internal: object, native: object) => unknown = runInNewContext(`(function(internal, native) { const polyfills = new Map(); ${loader}; return internal.require("web"); })`);
  const install = load(internal, native);
  if (typeof install !== "function") throw new Error("Web installer was not exported");
  const globals = new Map<string, unknown>();
  install((name: string, value: unknown) => globals.set(name, value), () => {});
  const Decoder: typeof TextDecoder = runInNewContext("internal.web.TextDecoder", { internal });
  if (globals.get("TextDecoder") !== Decoder) throw new Error("Web installer did not install TextDecoder");
  return { Decoder, handles };
}

export { singleByteCases } from "../tests/fixtures/text-decoder/cases";
