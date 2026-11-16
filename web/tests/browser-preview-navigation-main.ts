import { Previews } from "../src/preview";
import type { PreviewServer } from "waffle/browser/preview";

type PreviewSink = Parameters<PreviewServer["request"]>[2];

const previews = new Previews();
const requests = new Map<string, PreviewSink[]>();
previews.register(5173, {
  request(_port, request, sink) {
    const sinks = requests.get(request.target) ?? [];
    sinks.push(sink);
    requests.set(request.target, sinks);
    return true;
  },
  connect() { return null; },
});
Reflect.set(globalThis, "navigationFixture", {
  ready: previews.ready,
  url: (path: string) => previews.url(5173, path),
  count: (target: string) => requests.get(target)?.length ?? 0,
  answer(target: string, status: number, body: string) {
    const sink = requests.get(target)?.[0];
    if (!sink) throw new Error("Missing original guest request");
    sink.head({ status, statusText: "Guest status", headers: [["content-type", "text/html"], ["x-guest-response", "original"], ["referrer-policy", "no-referrer"]] });
    sink.data(new TextEncoder().encode(`<!doctype html><body><h1>${body}</h1></body>`));
    sink.end();
  },
});
