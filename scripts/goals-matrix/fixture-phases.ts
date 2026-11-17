import fs from "node:fs";

export type EnterPhase = (phase: string) => void;

function errorText(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

/**
 * Runs a native browser fixture and writes each phase to stderr synchronously.
 * The body error is printed before awaited shutdown starts, so a pending
 * browser.close or an outer hang cap can no longer hide where the fixture stood.
 */
export async function runFixturePhases(fixture: string, body: (enter: EnterPhase) => Promise<void>, shutdown: (enter: EnterPhase) => Promise<void>): Promise<void> {
  let current = "start";
  const write = (text: string): void => { fs.writeSync(2, `[fixture ${fixture}] ${text}\n`); };
  const enter: EnterPhase = phase => { current = phase; write(phase); };
  enter("start");
  try {
    await body(enter);
    enter("body-passed");
  } catch (error) {
    write(`failed in ${current}: ${errorText(error)}`);
    throw error;
  } finally {
    enter("shutdown-start");
    await shutdown(enter).catch((error: unknown) => {
      write(`shutdown failed in ${current}: ${errorText(error)}`);
      throw error;
    });
    enter("shutdown-end");
  }
}
