import type { ServerResponse } from "node:http";

// Response lifecycle cases shared by the Node reference server and the runtime source test.
export type Trace = { events: string[]; calls: string[] };
type Scenario = (response: ServerResponse, trace: Trace) => void;

function label(value: unknown): string {
  if (value === undefined || value === null) return "ok";
  if (typeof value === "object" && "code" in value && typeof value.code === "string") return value.code;
  return value instanceof Error ? value.message : String(value);
}

function attempt(trace: Trace, name: string, call: () => unknown): void {
  try {
    const value = call();
    trace.calls.push(`${name} returned ${typeof value === "boolean" ? value : typeof value}`);
  } catch (error) {
    trace.calls.push(`${name} threw ${label(error)}`);
  }
}

function state(response: ServerResponse): string {
  const { destroyed, headersSent, writableEnded, writableFinished, closed, finished, writable } = response;
  return JSON.stringify({ destroyed, headersSent, writableEnded, writableFinished, closed, finished, writable, errored: label(response.errored) });
}

function lateCalls(response: ServerResponse, trace: Trace): void {
  attempt(trace, "setHeader", () => response.setHeader("x-late", "1"));
  attempt(trace, "write", () => response.write("late", error => trace.calls.push(`write callback ${label(error)}`)));
  attempt(trace, "end", () => response.end("late", () => trace.calls.push("end callback")));
  trace.calls.push(`after late calls ${state(response)}`);
}

function recordEnd(trace: Trace) {
  return (error?: Error) => trace.calls.push(`end callback ${label(error)}`);
}

export const scenarios: Record<string, Scenario> = {
  "destroy-before-headers"(response, trace) { response.destroy(); lateCalls(response, trace); },
  "destroy-after-headers"(response, trace) {
    response.flushHeaders();
    response.destroy();
    attempt(trace, "writeHead", () => response.writeHead(500));
    lateCalls(response, trace);
  },
  "write-head-after-destroy"(response, trace) { response.destroy(); attempt(trace, "writeHead", () => response.writeHead(500)); lateCalls(response, trace); },
  "destroy-while-streaming"(response, trace) { response.write("first\n", () => { response.destroy(); lateCalls(response, trace); }); },
  "destroy-twice"(response, trace) { response.destroy(); response.destroy(new Error("ignored")); trace.calls.push(state(response)); },
  "error-after-output"(response, trace) { response.write("first\n", () => { response.destroy(new Error("deliberate output error")); trace.calls.push(state(response)); }); },
  "destroy-after-accepted-end"(response, trace) { response.end("complete", recordEnd(trace)); response.destroy(); trace.calls.push(state(response)); },
  "destroy-error-after-accepted-end"(response, trace) { response.end("complete", recordEnd(trace)); response.destroy(new Error("boom")); },
  "destroy-after-finish"(response, trace) { response.end("complete", () => { response.destroy(); trace.calls.push(`after finish ${state(response)}`); }); },
  "client-cancel"(response, trace) { response.write("first\n"); response.once("close", () => lateCalls(response, trace)); },
  complete(response) { response.end("alive"); },
};

export function observe(path: string, response: ServerResponse): Trace {
  const trace: Trace = { events: [], calls: [] };
  response.on("finish", () => trace.events.push(`finish ${state(response)}`));
  response.on("close", () => trace.events.push(`close ${state(response)}`));
  response.on("error", error => trace.events.push(`error ${label(error)}`));
  scenarios[path]?.(response, trace);
  return trace;
}

export function request(path: string, last: boolean): string {
  return `GET /${path} HTTP/1.1\r\nHost: localhost\r\n${last ? "Connection: close\r\n" : ""}\r\n`;
}

export function normalizeWire(text: string): string {
  return text.replace(/\r\nDate: [^\r]*/g, "");
}

// Every case runs on its own connection, then keep-alive reuse and a fresh connection prove recovery.
export const exchanges: { name: string; paths: string[]; cancelAfter?: string }[] = Object.keys(scenarios)
  .filter(name => name !== "complete")
  .map(name => ({ name, paths: [name], cancelAfter: name === "client-cancel" ? "first\n" : undefined }))
  .concat([{ name: "keep-alive", paths: ["complete", "complete"], cancelAfter: undefined }, { name: "recovery", paths: ["complete"], cancelAfter: undefined }]);
