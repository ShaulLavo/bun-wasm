import type { Logger } from "playwright";

export function clickStageEvidence(browser: string) {
  const origin = performance.now();
  let sequence = 0;
  function record(stage: string, event: string): void {
    console.info(JSON.stringify({ clickStage: stage, event, browser, sequence: ++sequence, elapsedMs: performance.now() - origin }));
  }
  const logger: Logger = {
    isEnabled: name => name === "api",
    log(name, severity, message) { record(name, `${severity}: ${message}`); },
  };
  async function run<T>(stage: string, operation: () => Promise<T>): Promise<T> {
    record(stage, "start");
    try {
      const result = await operation();
      record(stage, "end");
      return result;
    } catch (error) {
      record(stage, `failed: ${String(error)}`);
      throw error;
    }
  }
  return { logger, run };
}
