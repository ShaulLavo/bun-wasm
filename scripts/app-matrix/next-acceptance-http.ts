import type { Page } from "playwright";

interface RequestProbe {
  sequence: number;
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
  type ProbeState =
    | { stage: "fetch"; sequence: number; bytesRead: 0; eofObserved: false }
    | { stage: "headers"; sequence: number; status: number; bytesRead: 0; eofObserved: false }
    | { stage: "body"; sequence: number; status: number; bytesRead: number; eofObserved: false }
    | { stage: "eof"; sequence: number; status: number; bytesRead: number; eofObserved: true };
  let state: ProbeState = { stage: "fetch", sequence: probe.sequence, bytesRead: 0, eofObserved: false };

  function failureContext() {
    const status = "status" in state ? `; status=${state.status}` : "";
    return `HTTP probe request sequence=${state.sequence}; stage=${state.stage}${status}; bytes read=${state.bytesRead}; EOF observed=${state.eofObserved}`;
  }

  try {
    const response = await fetch(probe.url, { method: probe.method, headers: probe.headers, body: probe.body, signal: controller.signal });
    state = { stage: "headers", sequence: state.sequence, status: response.status, bytesRead: 0, eofObserved: false };
    if (probe.expectedStatus !== null && response.status !== probe.expectedStatus) throw new Error(`HTTP ${response.status}; expected ${probe.expectedStatus}: ${probe.url}`);
    if (!response.body) throw new Error(`Missing HTTP response body: ${probe.url}`);
    reader = response.body.getReader();
    state = { stage: "body", sequence: state.sequence, status: state.status, bytesRead: 0, eofObserved: false };
    while (true) {
      const part = await reader.read();
      if (part.done) {
        state = { stage: "eof", sequence: state.sequence, status: state.status, bytesRead: state.bytesRead, eofObserved: true };
        return { kind: "complete", status: response.status, body: body + decoder.decode(), chunks };
      }
      state = { stage: "body", sequence: state.sequence, status: state.status, bytesRead: state.bytesRead + part.value.byteLength, eofObserved: false };
      const text = decoder.decode(part.value, { stream: true });
      body += text;
      chunks.push({ text, timeMs: performance.now() - started });
      if (probe.mode === "cancel-after-first") return { kind: "cancelled", status: response.status, body, chunks };
    }
  } catch (error) {
    throw new Error(`${String(error)}; ${failureContext()}`);
  } finally {
    clearTimeout(timer);
    controller.abort();
    await reader?.cancel().catch(() => {});
    reader?.releaseLock();
  }
}

export function requestProbe(page: Page, probe: Pick<RequestProbe, "url" | "deadline"> & Partial<Omit<RequestProbe, "url" | "deadline">>) {
  const request: RequestProbe = { sequence: 1, method: "GET", headers: {}, body: null, expectedStatus: 200, mode: "complete", ...probe };
  return page.evaluate(browserRequest, request);
}
