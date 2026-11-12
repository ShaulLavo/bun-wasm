import { admit, awaitWithin, within, type Admission } from "./scope";

export type EvaluationOptions = { observation: true };
interface CleanupEvidence { browserClosed: true; foregroundStopped: true; previewClosed: true }
/**
 * Admit immediately before every send, enqueue, role switch or native input, including
 * after internal waits. Withdraw waiting work when admission closes. Retain dispatched
 * work until it settles or close ends it, while bounding the caller's await by admission.
 * Teardown is unguarded and always proceeds.
 */
export interface Transport {
  readonly capabilities: Record<string, unknown>;
  readonly processRoot?: number;
  beginCleanup?(admission: Admission): void | Promise<void>;
  nativeClick?(button: string, clicked: string, admission: Admission): Promise<unknown>;
  cleanup?(timeoutMs: number): Promise<CleanupEvidence>;
  navigate(url: string, admission: Admission): Promise<void>;
  evaluate<T>(expression: string, admission: Admission, options?: EvaluationOptions): Promise<T>;
  openPreview(url: string, admission: Admission): Promise<void>;
  useHost(admission: Admission): Promise<void>;
  usePreview(admission: Admission): Promise<void>;
  closePreview(admission: Admission): Promise<void>;
  close(interruptPending?: boolean, timeoutMs?: number): Promise<void>;
}
export type ScopedTransport = {
  readonly capabilities: Record<string, unknown>;
  readonly processRoot?: number;
  evaluate<T>(expression: string, options?: EvaluationOptions): Promise<T>;
  navigate(url: string): Promise<void>;
  openPreview(url: string): Promise<void>;
  useHost(): Promise<void>;
  usePreview(): Promise<void>;
  closePreview(): Promise<void>;
  nativeClick?(button: string, clicked: string, timeoutMs: number): Promise<unknown>;
};

export function scoped(transport: Transport, admission: Admission): ScopedTransport {
  const call = <T>(operation: () => Promise<T>, guard = admission): Promise<T> => {
    admit(guard);
    return awaitWithin(operation(), guard);
  };
  const nativeClick = transport.nativeClick?.bind(transport);
  return {
    capabilities: transport.capabilities,
    processRoot: transport.processRoot,
    evaluate: <T>(expression: string, options?: EvaluationOptions) => call(() => transport.evaluate<T>(expression, admission, options)),
    navigate: url => call(() => transport.navigate(url, admission)),
    openPreview: url => call(() => transport.openPreview(url, admission)),
    useHost: () => call(() => transport.useHost(admission)),
    usePreview: () => call(() => transport.usePreview(admission)),
    closePreview: () => call(() => transport.closePreview(admission)),
    ...(nativeClick ? { nativeClick: (button: string, clicked: string, timeoutMs: number) => {
      const guard = within(admission, timeoutMs, new Error(`Phase timed out after ${timeoutMs} ms`));
      return call(() => nativeClick(button, clicked, guard), guard);
    } } : {}),
  };
}
