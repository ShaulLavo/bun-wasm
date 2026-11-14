import { appendFileSync } from "node:fs";
import type { Browser, BrowserContext, Page } from "playwright";

export type StorageObservation = Pick<StorageLifetime, "step" | "event" | "acquire" | "own" | "observeContext" | "secondary">;
type RecordEvent = (event: { sequence: number; time: string; kind: string; detail: unknown }) => void;

function errorDetail(error: unknown): unknown {
  if (!(error instanceof Error)) return { error: String(error) };
  return { error: String(error), name: error.name, message: error.message, stack: error.stack,
    cause: error.cause instanceof Error ? { error: String(error.cause), stack: error.cause.stack } : String(error.cause) };
}

export class StorageLifetime {
  readonly failures: unknown[] = [];
  private readonly releases: (() => Promise<void>)[] = [];
  private readonly acquisitions: Promise<void>[] = [];
  private progressError: { error: unknown } | undefined;
  private cleanupTask: Promise<void> | undefined;
  private closing = false;
  private sequence = 0;
  private operation = 0;
  private page = 0;

  constructor(private readonly write?: RecordEvent) {}

  get observation(): StorageObservation | undefined { return this.write ? this : undefined; }

  event(kind: string, detail: unknown = null): void {
    try { this.write?.({ sequence: ++this.sequence, time: new Date().toISOString(), kind, detail }); }
    catch (error) { this.failProgress(error); }
  }

  private failProgress(error: unknown): void {
    if (this.progressError) return;
    this.progressError = { error };
    this.failures.push(error);
  }

  private checkProgress(): void {
    if (this.progressError) throw this.progressError.error;
  }

  async step<T>(phase: string, operation: () => T | PromiseLike<T>): Promise<T> {
    const id = ++this.operation;
    this.event("begin", { id, phase });
    this.checkProgress();
    try {
      const value = await operation();
      this.event("end", { id, phase });
      this.checkProgress();
      return value;
    } catch (error) {
      this.event("error", { id, phase, ...errorObject(error) });
      throw error;
    }
  }

  own(phase: string, close: () => void | PromiseLike<void>): () => Promise<void> {
    let task: Promise<void> | undefined;
    const release = () => task ??= this.release(phase, close);
    this.releases.push(release);
    if (this.closing) void release();
    return release;
  }

  secondary(phase: string, error: unknown): void {
    this.failures.push(error);
    this.event("secondary-error", { phase, ...errorObject(error) });
  }

  private async release(phase: string, close: () => void | PromiseLike<void>): Promise<void> {
    this.event("cleanup-begin", { phase });
    try { await close(); }
    catch (error) {
      this.secondary(phase, error);
    }
    this.event("cleanup-end", { phase });
  }

  acquire<T>(phase: string, open: () => Promise<T>, close: (value: T) => Promise<void>): Promise<{ value: T; release(): Promise<void> }> {
    return this.step(phase, () => this.trackAcquisition(phase, open(), close));
  }

  private trackAcquisition<T>(phase: string, opening: Promise<T>, close: (value: T) => Promise<void>): Promise<{ value: T; release(): Promise<void> }> {
    const pending = opening.then(value => this.adopt(phase, value, close));
    this.acquisitions.push(pending.then(() => {}, () => {}));
    return pending;
  }

  private async adopt<T>(phase: string, value: T, close: (value: T) => Promise<void>): Promise<{ value: T; release(): Promise<void> }> {
    const release = this.own(`${phase}.close`, () => close(value));
    if (this.closing) await release();
    return { value, release };
  }

  cleanup(): Promise<void> {
    this.closing = true;
    return this.cleanupTask ??= Promise.all(this.releases.map(release => release()).concat(this.acquisitions)).then(() => {});
  }

  assertClean(): void {
    if (this.failures.length) throw new AggregateError(this.failures, "Storage evidence or cleanup failed");
  }

  async run<T>(body: () => Promise<T>): Promise<T> {
    let primaryFailed = false;
    try { return await body(); }
    catch (error) {
      primaryFailed = true;
      this.event("primary-error", errorDetail(error));
      throw error;
    } finally {
      await this.cleanup();
      if (!primaryFailed) this.assertClean();
    }
  }

  observeBrowser(browser: Browser): void {
    browser.on("disconnected", () => this.event("browser-disconnected"));
  }

  observeContext(context: BrowserContext): void {
    context.on("page", page => this.observePage(page));
    context.on("close", () => this.event("context-close"));
  }

  private observePage(page: Page): void {
    const id = ++this.page;
    this.event("page", { page: id });
    page.on("console", message => this.event("console", { page: id, type: message.type(), text: message.text(), location: message.location() }));
    page.on("pageerror", error => this.event("pageerror", { page: id, ...errorObject(error) }));
    page.on("requestfailed", request => this.event("requestfailed", { page: id, url: request.url(), failure: request.failure() }));
    page.on("framenavigated", frame => this.event("navigation", { page: id, url: frame.url(), main: frame === page.mainFrame() }));
    page.on("crash", () => this.event("page-crash", { page: id }));
    page.on("close", () => this.event("page-close", { page: id }));
    page.on("worker", worker => {
      this.event("worker", { page: id, url: worker.url() });
      worker.on("close", () => this.event("worker-close", { page: id, url: worker.url() }));
    });
  }
}

function errorObject(error: unknown): { failure: unknown } { return { failure: errorDetail(error) }; }

export function storageEvidence(path: string | undefined): StorageLifetime {
  return new StorageLifetime(path ? event => appendFileSync(path, `${JSON.stringify(event)}\n`) : undefined);
}

export function storageStep<T>(observer: StorageObservation | undefined, phase: string, operation: () => Promise<T>): Promise<T> {
  return observer ? observer.step(phase, operation) : operation();
}
