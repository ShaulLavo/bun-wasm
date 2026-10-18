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

writeFileSync(outputPath, relative("posix", "relative_windows_t").concat(relative("windows", "resolve_posix_t")));
