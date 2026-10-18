import { readFileSync, writeFileSync } from "node:fs";

const [sourcePath, outputPath] = process.argv.slice(2);
if (!sourcePath || !outputPath) throw new Error("Usage: generate-node-path.ts <bun-node-path.rs> <output.rs>");
const source = readFileSync(sourcePath, "utf8");

function relative(platform: "posix" | "windows", next: string): string {
  const start = source.indexOf(`pub fn relative_${platform}_t`);
  const end = source.indexOf(`pub fn ${next}`, start);
  if (start < 0 || end < 0) throw new Error(`Missing Bun path function: ${platform}`);
  const original = source.slice(start, end);
  const first = original.indexOf("    if from_orig ==");
  const last = original.lastIndexOf("\n}");
  if (first < 0 || last < first) throw new Error(`Missing Bun relative computation: ${platform}`);
  const body = original.slice(first, last).replaceAll("T::from_u8(", "u16::from(").replaceAll("T::default()", "0");
  if (body.includes("resolve_") || body.includes("T::")) throw new Error(`Unexpected cwd or generic dependency: ${platform}`);
  return `fn relative_${platform}_resolved<'a>(from_orig: &[u16], buf: &'a mut [u16], to_orig_len: usize, tmp_buf: &mut [u16]) -> Result<&'a [u16], NativeError> {
    let from_orig_len = from_orig.len();
${platform === "posix" ? "    let to_orig = &buf[..to_orig_len];\n" : ""}${body}
}
`;
}

function upstreamFunction(name: string): string {
  const start = source.indexOf(`fn ${name}<`);
  const end = source.indexOf("\n}", start);
  if (start < 0 || end < 0) throw new Error(`Missing Bun path helper: ${name}`);
  return source.slice(start, end + 2);
}

function resolveWindowsWithCwd(): string {
  let resolver = upstreamFunction("resolve_windows_t")
    .replace("fn resolve_windows_t", "pub fn resolve_windows_guest_t")
    .replace("    paths: &[&[T]],\n    buf:", "    paths: &[&[T]],\n    cwd: &[T],\n    buf:")
    .replace("get_cwd_t(&mut tmp_buf[..])?", "guest_cwd(cwd, &mut tmp_buf[..])?")
    .replace("get_cwd_t(&mut tmp_buf[resolved_device_len..])?", "guest_cwd(cwd, &mut tmp_buf[resolved_device_len..])?");
  if (resolver.includes("get_cwd_t")) throw new Error("Guest resolver still uses host cwd");
  const normalize = upstreamFunction("normalize_string_t")
    .replace("fn normalize_string_t<T: PathCharCwd, const PLATFORM: Platform>", "fn normalize_string_t<T: PathCharCwd>")
    .replace(
      "let is_sep_t: fn(T) -> bool = if matches!(PLATFORM, Platform::Posix) {\n        is_sep_posix_t::<T>\n    } else {\n        is_sep_windows_t::<T>\n    };",
      "let is_sep_t = is_sep_windows_t::<T>;",
    );
  resolver = resolver.replace("normalize_string_t::<T, { Platform::Windows }>", "normalize_string_t::<T>");
  if (normalize.includes("Platform") || resolver.includes("Platform")) throw new Error("Unexpected platform-dependent path helper");
  const generated = `mod windows_resolver {
use super::{ffi, strings, MAX_PATH_BYTES, PATH_MAX_WIDE, cast_slice};
#[cfg(windows)]
use super::{w_path_buffer_pool, cast_slice_mut};
use bun_node_path::{PathCharCwd, is_sep_windows_t, CHAR_BACKWARD_SLASH, CHAR_FORWARD_SLASH, CHAR_STR_DOT};
type MaybeSlice<'a, T> = bun_sys::Result<&'a [T]>;
const CHAR_COLON: u8 = b':';
const CHAR_DOT: u8 = b'.';
const MAX_PATH_SIZE_UPPER: usize = if MAX_PATH_BYTES > PATH_MAX_WIDE { MAX_PATH_BYTES } else { PATH_MAX_WIDE };

fn guest_cwd<'a, T: PathCharCwd>(cwd: &[T], buf: &'a mut [T]) -> bun_sys::Result<&'a mut [T]> {
    if cwd.len() > buf.len() {
        return Err(bun_sys::Error::from_code(bun_sys::E::ENAMETOOLONG, bun_sys::Tag::TODO));
    }
    buf[..cwd.len()].copy_from_slice(cwd);
    Ok(&mut buf[..cwd.len()])
}

${["l", "eql_ignore_case_t", "to_lower_t", "memmove", "is_windows_device_root_t", "pop_last_segment_t"].map(upstreamFunction).join("\n\n")}

${normalize}

${resolver}
}
`;
  return generated.replaceAll("bun_core::ffi::", "ffi::").replaceAll("bun_paths::w_path_buffer_pool::", "w_path_buffer_pool::").replaceAll("bytemuck::cast_slice", "cast_slice");
}

writeFileSync(outputPath, resolveWindowsWithCwd().concat(relative("posix", "relative_windows_t"), relative("windows", "resolve_posix_t")));
