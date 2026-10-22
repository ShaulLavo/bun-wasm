import { Previews } from "../src/preview";
import type { PreviewServer } from "waffle/browser/preview";

declare global {
  var policyFixtureReady: string;
  var policyFixture: { guard: boolean; socketGuard: boolean; doctype: string | null };
  var socketSawPolicy: boolean;
}
const mode = new URL(location.href).searchParams.get("mode");
const documentPolicy = mode === "none" ? undefined : mode === "invalid" ? null : globalThis.__bunwasmPreviewPolicy;
const previews = new Previews({ documentPolicy });
const server: PreviewServer = {
  request(_port, request, sink) {
    const path = new URL(request.target, location.origin).pathname;
    const headers: [string, string][] = [["content-type", path.includes("xhtml") ? "application/xhtml+xml" : path.includes("charset") ? "text/html; charset=utf-16" : "text/html"], ["x-fixture", "preserved"]];
    if (path.includes("encoded")) headers.push(["content-encoding", "gzip"]);
    sink.head({ status: path.includes("error") ? 418 : 200, statusText: path.includes("error") ? "Teapot" : "OK", headers });
    const chunks = ["\ufeff <!doc", "type html>", '<html><body><h1>PREVIEW PROTOCOL DOUBLE, NO GUEST</h1><script>globalThis.policyFixture={guard:Array.isArray(globalThis.frameworkOfflineAudit),socketGuard:globalThis.socketSawPolicy===true,doctype:document.doctype?.name??null}</script></body></html>'];
    for (const chunk of chunks) sink.data(new TextEncoder().encode(chunk));
    sink.end();
    return true;
  },
  connect() { return null; },
};
previews.register(43100, server);
globalThis.policyFixtureReady = await previews.ready;
