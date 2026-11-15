/** A cooperative proof must not acknowledge native stop while its guest still runs.
 * Keep Waffle's observation lease until real return and the terminal FIFO barrier. */
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

  /** Emergency cleanup releases a pending stop without claiming either proof event. */
  force(): void {
    if (this.stopped) return;
    this.nativeStop();
    this.stopped = true;
    this.pending?.resolve();
  }

  private complete(): void {
    if (!this.pending || !this.exited || !this.returned) return;
    this.force();
  }
}
