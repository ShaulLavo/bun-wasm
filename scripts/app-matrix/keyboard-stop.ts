import type { Page } from "playwright";
import { stopShell } from "../../web/tests/stop-shell";

export async function stopMatrixServer(page: Page): Promise<void> {
  await stopShell(page);
  const code: unknown = await page.evaluate(async () => {
    await Reflect.get(globalThis, "__matrixCommand");
    return Reflect.get(Reflect.get(globalThis, "playground"), "shell").lastExit;
  });
  if (code !== 0 && code !== 130) throw new Error(`Keyboard Ctrl-C exited ${code}`);
}
