import type { ConsoleMessage, Page, Request, Response } from "playwright";
import { admit, awaitWithin, within, type Admission } from "./scope";

function documentState() {
  return { url: location.href.slice(0, 2048), readyState: document.readyState, title: document.title.slice(0, 2048),
    message: document.querySelector("#message")?.textContent?.slice(0, 2048) ?? null,
    body: document.body?.innerText.slice(0, 4096) ?? null };
}

export function capturePreviewFailure(page: Page) {
  type PreviewEvent = { kind: "pageerror" | "console"; detail: string }
    | { kind: "requestfailed"; detail: string; url: string }
    | { kind: "response"; detail: string; url: string; status: number };
  const events: PreviewEvent[] = [];
  let dropped = 0;
  function record(event: typeof events[number]) {
    if (events.length === 32) { dropped++; return; }
    events.push(event);
  }
  const pageError = (error: Error) => record({ kind: "pageerror", detail: (error.stack ?? error.message).slice(0, 2048) });
  const consoleError = (message: ConsoleMessage) => {
    if (message.type() === "error") record({ kind: "console", detail: message.text().slice(0, 2048) });
  };
  const requestFailed = (request: Request) => record({ kind: "requestfailed", url: request.url().slice(0, 2048), detail: request.failure()?.errorText.slice(0, 2048) ?? "unknown" });
  const responseFailed = (response: Response) => {
    if (response.status() >= 400) record({ kind: "response", url: response.url().slice(0, 2048), status: response.status(), detail: response.request().resourceType() });
  };
  page.on("pageerror", pageError);
  page.on("console", consoleError);
  page.on("requestfailed", requestFailed);
  page.on("response", responseFailed);
  return {
    async read(admission: Admission): Promise<string> {
      admit(admission);
      const guard = within(admission, 250, new Error("Preview DOM observation did not settle"));
      let document: unknown;
      try { document = await awaitWithin(page.evaluate(documentState), guard); }
      catch (error) { document = { unavailable: String(error).slice(0, 2048) }; }
      admit(admission);
      return `\n\nPreview failure observation:\n${JSON.stringify({ url: page.url().slice(0, 2048), events, dropped, document })}\n`;
    },
    release(): void {
      page.off("pageerror", pageError);
      page.off("console", consoleError);
      page.off("requestfailed", requestFailed);
      page.off("response", responseFailed);
      events.length = 0;
    },
  };
}
