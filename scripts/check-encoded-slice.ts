import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const vendor = resolve(process.argv[2] ?? join(root, "vendor/bun"));
const revision = process.argv[3];
function readSource(path: string): string {
  if (revision) return execFileSync("git", ["-C", vendor, "show", `${revision}:${path}`], { encoding: "utf8" });
  return readFileSync(join(vendor, path), "utf8");
}
const source = readSource("src/bun_core/string/mod.rs");
const alloc = readSource("src/bun_alloc/lib.rs");
const opaque = readSource("src/opaque/lib.rs");

function section(text: string, start: string, end: string): string {
  const from = text.indexOf(start);
  const to = text.indexOf(end, from + start.length);
  if (from < 0 || to < 0) throw new Error(`Missing source boundary: ${start}`);
  return text.slice(from, to);
}

function method(text: string, name: string): string {
  const pattern = new RegExp(`(?:    #\\[[^\\n]*\\]\\n)*    (?:pub(?:\\(crate\\))? )?(?:const )?fn ${name}\\(`);
  const match = pattern.exec(text);
  if (!match) throw new Error(`Missing actual method: ${name}`);
  const end = text.indexOf("\n    }", match.index);
  if (end < 0) throw new Error(`Missing method end: ${name}`);
  return text.slice(match.index, end + 6);
}

const methods = ["from_tagged_ptr", "detach_lifetime", "is_empty", "is_16bit", "is_utf8", "is_globally_allocated", "mark", "untagged", "latin1", "utf8", "utf16", "utf16_global", "untagged_ptr", "slice", "utf16_slice", "byte_slice", "substring_with_len", "substring", "trunc"];
const representation = source.includes("fn with_flag(") ? ["flags", "with_flag", "addr"] : ["tagged_ptr"];
const encodedImpl = section(source, "impl<'a> EncodedSlice<'a> {", "\n}\n");
const selected = methods.concat(representation).map((name) => method(encodedImpl, name)).join("\n");
const ffiTrait = section(opaque, "pub unsafe trait FfiLayout {", "\n}\n") + "\n}";
const ffiMacro = section(opaque, "#[macro_export]\nmacro_rules! assert_ffi_layout {", "\n}\n") + "\n}";
const empty = /    pub const EMPTY: Self = [^;]+;/.exec(encodedImpl)?.[0];
if (!empty) throw new Error("Missing actual EncodedSlice::EMPTY");
const stringImpl = section(source, "impl String {\n", "\n}\n");
const stringMethods = ["wrap", "borrow_utf8", "borrow_utf16", "ascii"].map((name) => method(stringImpl, name)).join("\n");
const sentinels = section(source, "impl String {\n", "\n    #[inline]").trimEnd();
const tagStart = source.lastIndexOf("#[repr(u8)]", source.indexOf("pub enum Tag"));
const typeStart = source.lastIndexOf("#[repr(C)]", source.indexOf("pub struct EncodedSlice"));
const constants = section(source, "// `EncodedSlice` pointer-tag scheme.", "/// ");
const types = source.slice(tagStart, source.indexOf("// C++ mirror:"));
const encodedType = section(source.slice(typeStart), "#[repr(C)]", "impl<'a> EncodedSlice<'a> {");
const wtfStart = alloc.lastIndexOf("#[repr(C)]", alloc.indexOf("pub struct WTFStringImplStruct"));
const wtfTypes = section(alloc.slice(wtfStart), "#[repr(C)]", "impl WTFStringImplStruct {");
const flagPrefix = source.includes("fn with_flag(") ? "FLAG" : "TAG";
const flagSuffix = flagPrefix === "FLAG" ? "" : "_BIT";
const probe = readFileSync(join(root, "tests/encoded-slice/probe.rs"), "utf8");
const generated = `#![allow(dead_code)]
use core::marker::PhantomData;
${ffiTrait}
${ffiMacro}
${wtfTypes}
${types}
crate::assert_ffi_layout!(String, 24, 8);
${constants}
${encodedType}
impl<'a> EncodedSlice<'a> {
${empty}
${selected}
}
${sentinels}
${stringMethods}
}
${probe.replaceAll("PROBE_UTF8", `${flagPrefix}_UTF8${flagSuffix}`).replaceAll("PROBE_GLOBAL", `${flagPrefix}_GLOBAL${flagSuffix}`).replaceAll("PROBE_UTF16", `${flagPrefix}_UTF16${flagSuffix}`)}
`;

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { stdio: "inherit", timeout: 60_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited ${result.status}`);
}

const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-encoded-slice-"));
const cleanup = () => rmSync(scratch, { recursive: true, force: true });
process.once("SIGINT", () => { cleanup(); process.exit(130); });
process.once("SIGTERM", () => { cleanup(); process.exit(143); });
try {
  const input = join(scratch, "actual.rs");
  writeFileSync(input, generated);
  const native = join(scratch, "native");
  run("rustc", ["--edition=2024", input, "-o", native]);
  run(native, []);
  const wasm = join(scratch, "probe.wasm");
  run("rustc", ["--edition=2024", "--target", "wasm32-wasip1", input, "-o", wasm]);
  run("wasmtime", ["run", wasm]);
} finally {
  cleanup();
}
