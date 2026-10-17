interface Request {
  url(): string;
  failure(): { errorText: string } | null;
}
type Event =
  | { kind: "request-failed"; url: string; error: string }
  | { kind: "http-error"; url: string; status: number }
  | { kind: "console-error"; text: string };
interface Page {
  on(event: "request" | "requestfinished" | "requestfailed", listener: (request: Request) => void): unknown;
  on(event: "response", listener: (response: { url(): string; status(): number }) => void): unknown;
  on(event: "console", listener: (message: { type(): string; text(): string }) => void): unknown;
}

export function browserDiagnostics(page: Page) {
  const pending = new Map<Request, string>();
  const events: Event[] = [];
  function record(event: Event) {
    events.push(event);
    if (events.length > 20) events.shift();
  }
  page.on("request", request => pending.set(request, request.url()));
  page.on("requestfinished", request => pending.delete(request));
  page.on("requestfailed", request => {
    pending.delete(request);
    record({ kind: "request-failed", url: request.url(), error: request.failure()?.errorText ?? "unknown" });
  });
  page.on("response", response => {
    if (response.status() >= 400) record({ kind: "http-error", url: response.url(), status: response.status() });
  });
  page.on("console", message => {
    if (message.type() === "error") record({ kind: "console-error", text: message.text() });
  });
  return () => ({ pending: Array.from(pending.values()), events: events.slice() });
}
