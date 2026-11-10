type Save = ((text: string) => Promise<void>) | undefined;
type Predicates = ReturnType<typeof iphoneClickPredicates>;

export function saveIphoneEvidence(save: Save, row: object): void {
  if (!save) return;
  try {
    const text = JSON.stringify({ ...row, at: new Date().toISOString() }) + "\n";
    void Promise.resolve().then(() => save(text)).catch(() => {});
  } catch { /* Evidence must never change input or teardown outcomes. */ }
}

export function iphoneClickExpression(button: string, clicked: string): string {
  return `(() => { const s = globalThis.__goalsIphoneClick, key = globalThis.__goalsIphoneDocument; return { trusted: s?.trusted === true, sameTarget: s?.target === document.querySelector(${JSON.stringify(button)}), timeOrigin: key?.timeOrigin, nonce: key?.nonce, url: location.href, after: document.querySelector(${JSON.stringify(clicked)})?.textContent?.trim() ?? '' }; })()`;
}

export function iphoneClickPredicates(before: Record<string, unknown>, value: Record<string, unknown>, expected: string) {
  return { trusted: value.trusted === true, sameTarget: value.sameTarget === true, url: value.url === before.url,
    timeOrigin: value.timeOrigin === before.timeOrigin, nonce: value.nonce === before.nonce, after: value.after === expected };
}

export class IphoneClickTrace {
  private readonly clickId = crypto.randomUUID();
  private progress = "arm-pending";
  private polls = 0;
  private sequence = 0;
  private last: Predicates | undefined;
  private changes = 0;
  private ended = false;
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly abort = () => this.finish("cancelled");
  constructor(private readonly save: Save, timeoutMs: number, private readonly signal: AbortSignal) {
    this.emit({ stage: this.progress });
    this.timer = setTimeout(() => this.finish("deadline"), timeoutMs);
    signal.addEventListener("abort", this.abort, { once: true });
  }
  private emit(row: object): void { saveIphoneEvidence(this.save, { event: "iphone-click", clickId: this.clickId, sequence: ++this.sequence, ...row }); }
  armed(before: Record<string, unknown>, expected: string): void {
    if (this.ended) return;
    this.emit({ stage: "armed", expectation: { before: String(before.before).slice(0, 200), after: expected.slice(0, 200),
      label: String(before.label).slice(0, 200), url: String(before.url).slice(0, 1024), timeOrigin: typeof before.timeOrigin === "number" ? before.timeOrigin : null, nonce: typeof before.nonce === "string" ? before.nonce.slice(0, 128) : null } });
  }
  stage(progress: "snapshot-pending" | "snapshot-returned" | "press-pending" | "press-returned"): void {
    if (this.ended) return;
    this.progress = progress;
    this.emit({ stage: progress });
  }
  observing(): void {
    if (this.ended) return;
    this.progress = "observation-pending";
    this.polls++;
    if (this.polls === 1) this.emit({ stage: this.progress, polls: this.polls });
  }
  observed(predicates: Predicates): void {
    if (this.ended) return;
    this.progress = "observation-returned";
    const changed = JSON.stringify(predicates) !== JSON.stringify(this.last);
    this.last = predicates;
    if (!changed || this.changes >= 12) return;
    this.changes++;
    this.emit({ stage: "observed", polls: this.polls, predicates });
  }
  finish(stage: "deadline" | "cancelled" | "passed" | "failed"): void {
    if (this.ended) return;
    this.ended = true;
    clearTimeout(this.timer);
    this.signal.removeEventListener("abort", this.abort);
    this.emit({ stage, progress: this.progress, polls: this.polls, predicates: this.last });
  }
}
