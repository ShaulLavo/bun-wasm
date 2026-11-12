import type { CDPSession } from "playwright";
import { array, canonical, object } from "./input";

declare const protocol: CDPSession;
type TraceStart = NonNullable<Parameters<typeof protocol.send<"Tracing.start">>[1]>;
export type BufferUsage = Parameters<Parameters<typeof protocol.on<"Tracing.bufferUsage">>[1]>[0];
export type TracingComplete = Parameters<Parameters<typeof protocol.on<"Tracing.tracingComplete">>[1]>[0];

export const chromeTraceConfig = {
  transferMode: "ReturnAsStream", streamFormat: "json", streamCompression: "none", bufferUsageReportingInterval: 1000,
  traceConfig: { recordMode: "recordUntilFull", traceBufferSizeInKb: 524288,
    includedCategories: ["disabled-by-default-v8.cpu_profiler", "blink.user_timing"], excludedCategories: ["*"] },
} satisfies TraceStart;

const requiredLossCounters = ["abi_violations", "bytes_overwritten", "chunks_discarded", "chunks_overwritten", "patches_failed",
  "incremental_sequences_dropped", "oversized_packets_dropped", "sequence_packet_loss", "trace_writer_packet_loss", "write_wrap_count",
  "data_loss_chunk_corrupted", "data_loss_orphan_continuation", "data_loss_overwrite", "data_loss_read_gap",
  "data_loss_reassembly_broken_chain", "data_loss_reassembly_gap", "data_loss_smb_full", "data_loss_writer_abort"];
const lossCounter = /^(?:abi_violations|chunks_discarded|chunks_overwritten|bytes_overwritten|patches_failed|incremental_sequences_dropped|oversized_packets_dropped|sequence_packet_loss|trace_writer_packet_loss|write_wrap_count|data_loss_.*)$/;

function nonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function acceptedRequest(record: Record<string, unknown>) {
  if (record.startAccepted !== true) return null;
  try {
    const requested = object(record.requested), config = object(requested.traceConfig), capacity = config.traceBufferSizeInKb;
    if (!nonnegative(capacity) || !Number.isSafeInteger(capacity) || capacity === 0) return null;
    const supported = { ...chromeTraceConfig, traceConfig: { ...chromeTraceConfig.traceConfig, traceBufferSizeInKb: capacity } };
    return canonical(requested) === canonical(supported) ? supported : null;
  } catch { return null; }
}

function bufferReasons(buffer: Record<string, unknown>, index: number): string[] {
  const reasons: string[] = [];
  if (requiredLossCounters.some(key => !nonnegative(buffer[key]))) reasons.push(`Buffer ${index} has missing or invalid loss counters`);
  if (!nonnegative(buffer.buffer_size) || buffer.buffer_size === 0 || !nonnegative(buffer.bytes_written)) {
    reasons.push(`Buffer ${index} has missing or invalid final capacity statistics`);
  } else if (buffer.bytes_written >= buffer.buffer_size) reasons.push(`Buffer ${index} is saturated at collection completion`);
  return reasons;
}

export function chromeRetention(input: unknown, telemetry: unknown) {
  const trace = object(input);
  const metadata = trace.metadata === undefined ? {} : object(trace.metadata);
  const stats = metadata.trace_processor_stats === undefined ? {} : object(metadata.trace_processor_stats);
  const buffers = stats.traced_buf === undefined ? [] : array(stats.traced_buf).map(object);
  const loss = buffers.flatMap((buffer, index) => Object.entries(buffer)
    .filter(([key, value]) => lossCounter.test(key) && value !== 0)
    .map(([counter, value]) => ({ buffer: index, counter, value })));
  const record = telemetry === null || telemetry === undefined ? {} : object(telemetry);
  const complete = record.tracingComplete === null || record.tracingComplete === undefined ? {} : object(record.tracingComplete);
  const usage = record.bufferUsage === undefined ? [] : array(record.bufferUsage).map(object);
  const fractions = usage.map(row => { const event = object(row.event); return event.percentFull ?? event.value; });
  const reasons: string[] = [];
  const verifiedRequest = acceptedRequest(record);
  if (!verifiedRequest) reasons.push("Accepted supported collector request is missing or invalid");
  if (verifiedRequest && buffers[0]?.buffer_size !== verifiedRequest.traceConfig.traceBufferSizeInKb * 1024) {
    reasons.push("Requested collector capacity differs from the main trace buffer");
  }
  if (complete.dataLossOccurred !== false) reasons.push("Tracing completion loss status is missing or reports loss");
  if (record.streamReadComplete !== true) reasons.push("Complete stream retention is unverified");
  if (!fractions.length || fractions.some(value => typeof value !== "number" || !Number.isFinite(value) || value < 0 || value >= 1)) reasons.push("Buffer usage is missing, invalid or saturated");
  if (!buffers.length) reasons.push("Trace buffer statistics are unavailable");
  reasons.push(...buffers.flatMap(bufferReasons));
  if (loss.length) reasons.push("Trace metadata reports discarded, overwritten or otherwise lost data");
  return { available: reasons.length === 0, reasons, dataLossOccurred: complete.dataLossOccurred ?? null,
    bufferUsageReports: usage.length, buffers, loss, verifiedRequest,
    coverage: "Protocol completion, buffer telemetry and trace buffer loss counters; sampling still does not prove continuous CPU coverage" };
}
