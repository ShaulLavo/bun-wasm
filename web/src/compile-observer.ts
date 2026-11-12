/** Host-only direct WebAssembly compiler spans for the optional benchmark observer. */

interface CompileObservationRequest {
  readonly runId: string;
  readonly program: { readonly kind: string };
  readonly [key: string]: unknown;
}

interface Span { readonly part: string; readonly startMs: number; readonly endMs: number }
interface ActiveObservation { readonly request: CompileObservationRequest; readonly spans: Span[]; failed: boolean }

declare global {
  var __bunwasmCompileRequest: CompileObservationRequest | undefined;
  var __bunwasmCompileObserver: {
    begin(request: CompileObservationRequest): void;
    end(request: CompileObservationRequest): (CompileObservationRequest & { readonly spans: readonly Span[] }) | null;
  } | undefined;
}

let active: ActiveObservation | undefined;

/** Install the page control once; it does not patch WebAssembly by itself. */
export function installCompileObserver(): void {
  if (globalThis.__bunwasmCompileObserver) return;
  globalThis.__bunwasmCompileObserver = {
    begin(request) {
      if (!request.runId) throw new Error("compile observation runId is required");
      if (active) throw new Error("compile observation is already active");
      active = { request, spans: [], failed: false };
    },
    end(request) {
      if (!active || active.request.runId !== request.runId) return null;
      const current = active;
      active = undefined;
      const parts = current.request.program.kind === "single" ? ["core"] : ["core", "side"];
      if (current.failed || current.spans.length !== parts.length || parts.some(part => current.spans.filter(span => span.part === part).length !== 1)) return null;
      return { ...current.request, spans: current.spans };
    },
  };
  if (globalThis.__bunwasmCompileRequest) {
    globalThis.__bunwasmCompileObserver.begin(globalThis.__bunwasmCompileRequest);
    delete globalThis.__bunwasmCompileRequest;
  }
}

/** Measure one compiler call while preserving the native WebAssembly API. */
export async function observeCompile<T>(part: string, operation: () => Promise<T>): Promise<T> {
  const observation = active;
  if (!observation) return operation();
  const startMs = performance.now();
  try {
    const result = await operation();
    observation.spans.push({ part, startMs, endMs: performance.now() });
    return result;
  } catch (error) {
    observation.failed = true;
    throw error;
  }
}

/** Waffle owns additional linker compiles; this boundary cannot report a complete pair. */
export function withoutCompileSpans<T>(operation: () => Promise<T>): Promise<T> {
  if (active) active.failed = true;
  return operation();
}

/** The experimental shell receives its tier before its first worker starts. */
export function measurementEnvironment(params: URLSearchParams): Record<string, string> {
  const tier = params.get("measurement-tier");
  if (tier === null) return {};
  if (params.get("engine") !== "spidermonkey" || !["interp", "pbl"].includes(tier)
    || params.get("measurement-arm") !== `spidermonkey-${tier}`) throw new Error("invalid measurement tier selection");
  return { BUN_WASM_SPIDERMONKEY_TIER: tier };
}
