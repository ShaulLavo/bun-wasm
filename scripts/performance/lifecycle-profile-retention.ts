import type { CDPSession } from "playwright";
import { array, object } from "./input";

declare const protocol: CDPSession;
type TraceStart = NonNullable<Parameters<typeof protocol.send<"Tracing.start">>[1]>;
export type BufferUsage = Parameters<Parameters<typeof protocol.on<"Tracing.bufferUsage">>[1]>[0];
export type TracingComplete = Parameters<Parameters<typeof protocol.on<"Tracing.tracingComplete">>[1]>[0];

export const chromeTraceConfig = {
  transferMode: "ReturnAsStream", streamFormat: "json", streamCompression: "none", bufferUsageReportingInterval: 1000,
  traceConfig: { recordMode: "recordUntilFull", traceBufferSizeInKb: 204800,
    includedCategories: ["disabled-by-default-v8.cpu_profiler", "blink.user_timing"], excludedCategories: ["*"] },
} satisfies TraceStart;

export function chromeRetention(input: unknown, telemetry: unknown) {
  const trace = object(input);
  const metadata = trace.metadata === undefined ? {} : object(trace.metadata);
  const stats = metadata.trace_processor_stats === undefined ? {} : object(metadata.trace_processor_stats);
  const buffers = stats.traced_buf === undefined ? [] : array(stats.traced_buf).map(object);
  const loss = buffers.flatMap((buffer, index) => Object.entries(buffer)
    .filter(([key, value]) => /^(?:chunks_discarded|chunks_overwritten|bytes_overwritten|patches_failed|incremental_sequences_dropped|oversized_packets_dropped|sequence_packet_loss|trace_writer_packet_loss|data_loss_.*)$/.test(key) && value !== 0)
    .map(([counter, value]) => ({ buffer: index, counter, value })));
  const record = telemetry === null || telemetry === undefined ? {} : object(telemetry);
  const complete = record.tracingComplete === null || record.tracingComplete === undefined ? {} : object(record.tracingComplete);
  const usage = record.bufferUsage === undefined ? [] : array(record.bufferUsage).map(object);
  const fractions = usage.map(row => { const event = object(row.event); return event.percentFull ?? event.value; });
  const reasons: string[] = [];
  if (complete.dataLossOccurred !== false) reasons.push("Tracing completion loss status is missing or reports loss");
  if (record.streamReadComplete !== true) reasons.push("Complete stream retention is unverified");
  if (!fractions.length || fractions.some(value => typeof value !== "number" || !Number.isFinite(value) || value < 0 || value >= 1)) reasons.push("Buffer usage is missing, invalid or saturated");
  if (!buffers.length) reasons.push("Trace buffer statistics are unavailable");
  if (loss.length) reasons.push("Trace metadata reports discarded, overwritten or otherwise lost data");
  return { available: reasons.length === 0, reasons, dataLossOccurred: complete.dataLossOccurred ?? null,
    bufferUsageReports: usage.length, buffers, loss,
    coverage: "Protocol completion, buffer telemetry and trace buffer loss counters; sampling still does not prove continuous CPU coverage" };
}
