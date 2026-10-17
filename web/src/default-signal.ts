/** A guest explicitly choosing the default action, not an unrelated guest trap. */
export class DefaultSignal extends Error {
  constructor(readonly signal: number) {
    super(`Process stopped by signal ${signal}`);
  }
}
