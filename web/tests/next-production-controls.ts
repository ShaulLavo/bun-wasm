import assert from "node:assert/strict";

type Teardown = {
  readTerminal(): Promise<string>;
  writeTerminal(text: string): void;
  stopForeground(): Promise<void>;
  close(): Promise<void>;
  readTimeoutMs?: number;
};

export function assertProductionBrowserEvents(events: readonly string[]): void {
  assert.deepEqual(events.filter(event => /^(?:playground|preview) (?:error|assert|pageerror|requestfailed):/.test(event)), []);
}

export async function finishProduction(options: Teardown): Promise<void> {
  const failures: unknown[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Production terminal read timed out")), options.readTimeoutMs ?? 5_000);
    });
    options.writeTerminal(await Promise.race([options.readTerminal(), expired]));
  } catch (error) {
    failures.push(error);
  } finally {
    clearTimeout(timer);
  }
  try { await options.stopForeground(); } catch (error) { failures.push(error); }
  try { await options.close(); } catch (error) { failures.push(error); }
  if (failures.length > 0) throw failures[0];
}
