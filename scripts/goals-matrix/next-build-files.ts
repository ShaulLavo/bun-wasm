export const nextBuildFiles = [
  { path: "/home/user/.next/diagnostics/build-diagnostics.json", limit: 16_384, tail: false },
  { path: "/home/user/.next/next-server.js.nft.json", limit: 262_144, tail: false },
  { path: "/home/user/.next/next-minimal-server.js.nft.json", limit: 262_144, tail: false },
  { path: "/home/user/.next/trace", limit: 65_536, tail: true },
] as const;
type NextBuildPath = typeof nextBuildFiles[number]["path"];
export type FileRead = { path: NextBuildPath } & (
  | { status: "read"; text: string; bytes: number; size: number; offset: number; truncated: boolean }
  | { status: "unavailable"; reason: string }
);
interface TraceSpan { name: string; traceId: string; id: number; parentId: number | null; startTime: number; duration: number }
export type ParsedFile = { path: NextBuildPath } & (
  | { status: "unavailable"; reason: string }
  | { status: "partial"; reason: string }
  | { status: "diagnostics"; buildStage: string | null; buildOptions: { useBuildWorker: boolean | null } }
  | { status: "manifest"; version: number; files: string[] }
  | { status: "trace"; coverage: "complete" | "tail"; completeBatches: number; partialBatches: number; invalidBatches: number; spans: TraceSpan[] }
);
export function record(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
const spanNames = new Set(["next-build", "node-file-trace-build", "apply-include-excludes", "collect-build-traces", "webpack-compilation", "run-webpack-compiler", "static-generation", "collect-page-data"]);
function traceSpan(value: unknown): TraceSpan | undefined {
  const row = record(value);
  if (!row || typeof row.name !== "string" || !spanNames.has(row.name) || typeof row.traceId !== "string" || row.traceId.length > 128) return;
  if (typeof row.id !== "number" || !Number.isSafeInteger(row.id) || typeof row.startTime !== "number" || !Number.isFinite(row.startTime)) return;
  if (typeof row.duration !== "number" || !Number.isFinite(row.duration) || row.duration < 0) return;
  return { name: row.name, traceId: row.traceId, id: row.id, parentId: typeof row.parentId === "number" && Number.isSafeInteger(row.parentId) ? row.parentId : null, startTime: row.startTime, duration: row.duration };
}
function trace(file: Extract<FileRead, { status: "read" }>): ParsedFile {
  const lines = file.text.split("\n");
  // A tail can start inside an event or batch. Never salvage objects from that fragment.
  if (file.offset > 0) lines.shift();
  let completeBatches = 0, invalidBatches = 0, partialBatches = file.offset > 0 ? 1 : 0;
  const spans: TraceSpan[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let value: unknown;
    try { value = JSON.parse(line); }
    catch { partialBatches++; continue; }
    if (!Array.isArray(value)) { invalidBatches++; continue; }
    completeBatches++;
    for (const event of value) { const span = traceSpan(event); if (span) spans.push(span); }
  }
  return { path: file.path, status: "trace", coverage: file.truncated ? "tail" : "complete", completeBatches, invalidBatches, partialBatches, spans };
}
export function parseBuildFile(file: FileRead): ParsedFile {
  if (file.status === "unavailable") return file;
  if (file.path.endsWith("/trace")) return trace(file);
  if (file.truncated) return { path: file.path, status: "partial", reason: "File exceeds bound or changed during read; no complete JSON evidence" };
  let value: unknown;
  try { value = JSON.parse(file.text); }
  catch { return { path: file.path, status: "partial", reason: "Incomplete or invalid JSON" }; }
  const json = record(value);
  if (!json) return { path: file.path, status: "partial", reason: "Unexpected JSON shape" };
  if (file.path.endsWith(".nft.json")) return manifest(file.path, json);
  const options = record(json.buildOptions);
  return { path: file.path, status: "diagnostics", buildStage: typeof json.buildStage === "string" ? json.buildStage.slice(0, 128) : null, buildOptions: { useBuildWorker: typeof options?.useBuildWorker === "boolean" ? options.useBuildWorker : null } };
}
function manifest(path: NextBuildPath, json: Record<string, unknown>): ParsedFile {
  if (typeof json.version !== "number" || !Number.isSafeInteger(json.version) || !Array.isArray(json.files) || !json.files.every((item: unknown) => typeof item === "string")) return { path, status: "partial", reason: "Unexpected manifest shape" };
  const files: string[] = json.files;
  return { path, status: "manifest", version: json.version, files: files.sort() };
}
export function compareBuildFiles(baseline: readonly ParsedFile[], current: readonly ParsedFile[], dispatchedAt: number) {
  return current.map(file => {
    const previous = baseline.find(item => item.path === file.path);
    if (file.status === "manifest") return { path: file.path, status: file.status, version: file.version, fileCount: file.files.length, contentCompared: previous?.status === "manifest", changed: previous?.status === "manifest" ? JSON.stringify(previous) !== JSON.stringify(file) : null, freshness: "unknown; manifest writes have no production trace identity" };
    if (file.status !== "trace") return file;
    const old = previous?.status === "trace" ? previous.spans : [];
    const spans = file.spans.map(span => ({ ...span, seenInBaseline: old.some(item => item.traceId === span.traceId && item.id === span.id), afterDispatch: span.startTime >= dispatchedAt }));
    return { ...file, spans, freshProductionTraceIds: Array.from(new Set(spans.filter(span => span.afterDispatch && !span.seenInBaseline && ["next-build", "node-file-trace-build", "apply-include-excludes"].includes(span.name)).map(span => span.traceId))) };
  });
}
