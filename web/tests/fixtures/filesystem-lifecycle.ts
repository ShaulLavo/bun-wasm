import { SharedFilesystem } from "../../src/shared-fs";

const options = new URLSearchParams(location.search);
const storage = options.get("storage") === "opfs" ? "opfs" : "indexeddb";
const id = crypto.randomUUID();
function log(event: Event) {
  const events = JSON.parse(sessionStorage.getItem("lifecycle") ?? "[]");
  events.push({ type: event.type, persisted: "persisted" in event ? event.persisted : false, id });
  sessionStorage.setItem("lifecycle", JSON.stringify(events));
}
addEventListener("pagehide", log);
addEventListener("pageshow", log);
const fs = new SharedFilesystem({ storage, name: options.get("name") ?? "lifecycle" });
const state = { fs, id, ready: false, error: "" };
Object.assign(globalThis, { lifecycle: state });
void fs.mkdirp("/").then(() => { state.ready = true; document.body.append(" Ready."); }, error => {
  state.error = String(error);
  document.body.append(Object.assign(document.createElement("pre"), { textContent: state.error }));
});
