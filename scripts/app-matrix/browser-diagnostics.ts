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
    events.push("url" in event ? { ...event, url: diagnosticURL(event.url) } : { ...event, text: redactDiagnosticText(event.text) });
    if (events.length > 20) events.shift();
  }
  page.on("request", request => pending.set(request, diagnosticURL(request.url())));
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


function diagnosticURL(input: string): string {
  try { const url = new URL(input); url.search = ""; url.hash = ""; return url.href; }
  catch { return redactDiagnosticText(input); }
}
export function redactDiagnosticText(input: string): string {
  return input.replace(/([?&](?:token|access_token|auth|authorization|secret|api_key|key)=)[^&#\s"'<>]+/gi, "$1[redacted]");
}
