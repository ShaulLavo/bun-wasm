import { writeSync } from "node:fs";

/** Diagnostics go straight to the supervised child log before any cleanup await. */
export class ToolsLifecycle {
  private pending = "driver-start";
  private completed: string | null = null;
  private fields: Readonly<Record<string, string>> = {};
  private readonly started = performance.now();
  private readonly emit: (record: string) => void;

  constructor(emit: (record: string) => void = record => { writeSync(2, `${record}\n`); }) { this.emit = emit; }

  select(browser: string, engine: string): void { this.fields = { browser, engine }; }

  private record(event: string, error?: unknown): void {
    this.emit(JSON.stringify({ diagnostic: "tools-lifecycle", ...this.fields, event, elapsedMs: performance.now() - this.started,
      pending: this.pending, completed: this.completed,
      ...(error === undefined ? {} : { error: error instanceof Error ? error.stack ?? String(error) : String(error) }) }));
  }

  async step<T>(operation: string, body: () => Promise<T>): Promise<T> {
    this.pending = operation;
    this.record("start");
    const result = await body();
    this.completed = operation;
    this.record("pass");
    return result;
  }

  async cleanup(close: () => Promise<void>): Promise<void> {
    this.record("cleanup-start");
    try { await close(); }
    catch (error) { this.record("cleanup-error", error); throw error; }
    this.record("cleanup-complete");
  }

  async deadline(close: () => Promise<void>): Promise<void> {
    this.record("deadline", new Error("Tools driver exceeded its existing five-minute guard"));
    await this.cleanup(close);
  }

  async run(body: () => Promise<void>, close: () => Promise<void>): Promise<void> {
    const outcome = await this.body(body);
    try { await this.cleanup(close); }
    catch (error) {
      if (outcome.kind === "failed") throw new AggregateError([outcome.error, error], "Tools body and cleanup failed");
      throw error;
    }
    if (outcome.kind === "failed") throw outcome.error;
  }

  private async body(body: () => Promise<void>) {
    try { await body(); return { kind: "passed" } as const; }
    catch (error) { this.record("body-error", error); return { kind: "failed", error } as const; }
  }
}
