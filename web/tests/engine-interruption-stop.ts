/** Acknowledge genuine guest/bootstrap execution quiescence after real return and
 * the terminal FIFO barrier. The host Worker scaffold stays physically alive until teardown. */
export class CooperativeWorkerStop {
  private exited = false;
  private returned = false;
  private stopped = false;
  private pending: ReturnType<typeof Promise.withResolvers<void>> | undefined;

  constructor(private readonly nativeStop: () => void) {}

  request(): Promise<void> {
    this.pending ??= Promise.withResolvers<void>();
    if (this.stopped) this.pending.resolve();
    else this.complete();
    return this.pending.promise;
  }

  observeExit(): void { this.exited = true; this.complete(); }
  observeReturn(): void { this.returned = true; this.complete(); }

  /** Call after capturing failure evidence. Actual forced native stop must finish
   * before releasing the acknowledgement, so broker disposal cannot deadlock. */
  force(): void {
    if (this.stopped) return;
    this.nativeStop();
    this.stopped = true;
    this.pending?.resolve();
  }

  private complete(): void {
    if (!this.pending || !this.exited || !this.returned) return;
    // Execution is quiescent; physical Worker termination remains disabled for the proof.
    this.pending.resolve();
  }
}
