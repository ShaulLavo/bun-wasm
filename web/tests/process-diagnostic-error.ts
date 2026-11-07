export function processDiagnosticError(error: unknown): string {
  try { return String(error).slice(0, 1024); }
  catch { return "diagnostic error could not be formatted"; }
}
