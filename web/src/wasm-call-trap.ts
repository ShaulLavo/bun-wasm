/** A diagnostic callback must not replace the original Wasm trap. */
export function reportWasmCallTrap(observer: ((error: WebAssembly.RuntimeError, index: number) => void) | undefined, error: unknown, index: number): void {
  if (!(error instanceof WebAssembly.RuntimeError)) return;
  try { observer?.(error, index); }
  catch { /* Preserve the original trap when diagnostics fail. */ }
}
