import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import "../src/style.css";
import { PreviewRouter } from "waffle/browser/preview";
import { installPreviewLinks } from "../src/playground/preview-links";

const term = new Terminal({ cols: 100, rows: 8, fontSize: 14 });
term.open(document.querySelector<HTMLElement>("#terminal")!);
document.querySelector("#terminal")!.addEventListener("click", () => term.focus());
const previews = new PreviewRouter({ baseURL: location.href, prefix: "preview" });
const server = { request: () => false, connect: () => null };
previews.register(5173, server);
previews.register(4173, server);
const editor = document.querySelector<HTMLTextAreaElement>("#editor")!;
const dispose = installPreviewLinks(term, previews, new Set([5173, 4173]), () => editor.focus());
const urls = [previews.url(5173, "/nested?value=%2F#hello"), "http://localhost:5173/raw?value=%2F#raw", previews.url(4173), "https://example.com/", new URL("preview/9999/", location.href).href];
const osc8 = (url: string) => `\x1b]8;;${url}\x07Open preview\x1b]8;;\x07`;
term.write(urls.map((url, index) => index === 1 ? url : osc8(url)).join("\r\n"), () => {
  document.body.dataset.ready = "true";
});
Object.assign(globalThis, { previewFixture: {
  term, dispose, activate: term.options.linkHandler?.activate,
  stop: () => previews.unregister(5173, server),
} });
