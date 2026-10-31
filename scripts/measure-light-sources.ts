// Generated source-map spans attribute runtime vs demo bytes. Never confuse fragment gzip with transfer.
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";

function fields(segment: string): number[] {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const output: number[] = [];
  let value = 0, shift = 0;
  for (const char of segment) {
    const digit = alphabet.indexOf(char);
    assert.ok(digit >= 0, "valid source-map digit");
    value += (digit & 31) * 2 ** shift;
    if (digit & 32) { shift += 5; continue; }
    output.push(value & 1 ? -Math.floor(value / 2) : value / 2);
    value = shift = 0;
  }
  assert.equal(shift, 0, "complete source-map segment");
  return output;
}
function isUi(source: string): boolean {
  // Page code: the Remix components and the page models under web/src/playground and sandbox/src.
  return /node_modules\/(?!waffle\/)/.test(source) || /\.tsx$|(?:^|\/)playground\//.test(source)
    || /(?:^|\/)(?:main|shell|examples|terminal-copy|terminal-links|terminal-mount|viewport|sandbox|editor|template|deps-cache|startup-output)\.ts$/.test(source);
}
function isProcessService(source: string): boolean {
  const match = /(?:^|\/)(?:proc|browser)\/([^/]+)\.(?:ts|js)$/.exec(source);
  if (!match) return /\/subprocess\.(?:ts|js)$/.test(source);
  if (source.includes("/browser/")) return ["process-broker", "worker-pipes", "worker-client"].includes(match[1]!);
  return !["identity", "stub", "intrinsics", "control", "directory", "outcome", "start-errno", "start-failure", "wait-status", "signals", "types", "command"].includes(match[1]!);
}
export async function sourceAttribution(path: string, code: string) {
  const mapFile = Bun.file(`${path}.map`);
  if (!await mapFile.exists()) {
    assert.ok(path.endsWith("/sw.js"), `Missing JS source map: ${path}`);
    return { runtime: { bytes: Buffer.byteLength(code), gzip: gzipSync(code, { level: 9 }).length }, uiSources: [], processService: [], note: "Classic service worker is entirely runtime; no demo UI" };
  }
  const map: unknown = await mapFile.json();
  assert.ok(map && typeof map === "object" && "sources" in map && "mappings" in map);
  assert.ok(Array.isArray(map.sources) && map.sources.every((source: unknown) => typeof source === "string") && typeof map.mappings === "string");
  const sources: string[] = map.sources;
  const mappingLines = map.mappings.split(";");
  const lines = code.split("\n");
  const runtime: string[] = [];
  const mapped = new Set<string>();
  let sourceIndex = 0;
  for (const [index, line] of lines.entries()) {
    let column = 0, previous = 0, source = "";
    for (const segment of (mappingLines[index] ?? "").split(",").filter(Boolean)) {
      const decoded = fields(segment);
      column += decoded[0]!;
      if (source && column > previous) mapped.add(source);
      if (source && !isUi(source)) runtime.push(line.slice(previous, column));
      source = decoded.length >= 4 ? sources[sourceIndex += decoded[1]!]! : "";
      previous = column;
    }
    if (source && previous < line.length) mapped.add(source);
    if (source && !isUi(source)) runtime.push(line.slice(previous) + (index < lines.length - 1 ? "\n" : ""));
  }
  const bytes = Buffer.from(runtime.join(""));
  return { runtime: { bytes: bytes.length, gzip: bytes.length ? gzipSync(bytes, { level: 9 }).length : 0 }, uiSources: Array.from(mapped).filter(isUi), processService: Array.from(mapped).filter(isProcessService) };
}
