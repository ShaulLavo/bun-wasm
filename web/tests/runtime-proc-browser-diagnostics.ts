// Preserve the complete bounded fixture payload, including failures before result publication.
// Multiline JSON keeps admission and I/O entries readable in CI without one oversized log line.
export async function runtimeProcFailure(
  metadata: Record<string, unknown>,
  error: unknown,
  result: Record<string, unknown> | undefined,
  snapshot: () => Promise<Record<string, unknown> | undefined>,
): Promise<string> {
  let diagnostics = result;
  if (!diagnostics) {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      diagnostics = await Promise.race([snapshot(), new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("live diagnostics snapshot timed out")), 2000);
      })]);
    } catch (snapshotError) {
      diagnostics = { diagnosticsError: String(snapshotError) };
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
  diagnostics ??= { diagnosticsError: "live diagnostics unavailable" };
  return JSON.stringify({ ...metadata, ...diagnostics, ok: false, assertionError: String(error) }, null, 2);
}
