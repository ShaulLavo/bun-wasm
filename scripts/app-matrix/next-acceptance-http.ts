import type { Page } from "playwright";

interface RequestProbe {
  url: string;
  deadline: number;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body: string | null;
  expectedStatus: number | null;
  mode: "complete" | "cancel-after-first";
}

async function browserRequest(probe: RequestProbe) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("HTTP probe deadline exceeded", "TimeoutError")), Math.max(0, probe.deadline - Date.now()));
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const chunks: { text: string; timeMs: number }[] = [];
  const decoder = new TextDecoder();
  const started = performance.now();
  let body = "";
  try {
    const response = await fetch(probe.url, { method: probe.method, headers: probe.headers, body: probe.body, signal: controller.signal });
    if (probe.expectedStatus !== null && response.status !== probe.expectedStatus) throw new Error(`HTTP ${response.status}; expected ${probe.expectedStatus}: ${probe.url}`);
    if (!response.body) throw new Error(`Missing HTTP response body: ${probe.url}`);
    reader = response.body.getReader();
    while (true) {
      const part = await reader.read();
      if (part.done) return { kind: "complete", status: response.status, body: body + decoder.decode(), chunks };
      const text = decoder.decode(part.value, { stream: true });
      body += text;
      chunks.push({ text, timeMs: performance.now() - started });
      if (probe.mode === "cancel-after-first") return { kind: "cancelled", status: response.status, body, chunks };
    }
  } finally {
    clearTimeout(timer);
    controller.abort();
    await reader?.cancel().catch(() => {});
    reader?.releaseLock();
  }
}

export function requestProbe(page: Page, probe: Pick<RequestProbe, "url" | "deadline"> & Partial<Omit<RequestProbe, "url" | "deadline">>) {
  const request: RequestProbe = { method: "GET", headers: {}, body: null, expectedStatus: 200, mode: "complete", ...probe };
  return page.evaluate(browserRequest, request);
}
