import { createServer, type ServerResponse } from "node:http";

const closed: { path: string; finished: boolean; destroyed: boolean }[] = [];
const errors: string[] = [];
let producers = 0;

function recordClose(path: string, response: ServerResponse): void {
  response.once("close", () => closed.push({ path, finished: response.writableFinished, destroyed: response.destroyed }));
}

function streamUntilCancelled(response: ServerResponse): void {
  producers++;
  response.write("first\n");
  const timer = setInterval(() => response.write("more\n"), 20);
  response.once("close", () => { clearInterval(timer); producers--; });
}

const server = createServer((request, response) => {
  const path = request.url ?? "/";
  if (path === "/events") {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ closed, errors, producers }));
    return;
  }
  recordClose(path, response);
  if (path === "/ok") { response.end("alive"); return; }
  if (path === "/before") { response.destroy(); return; }
  if (path === "/late-end") { response.destroy(); response.end("late"); return; }
  if (path === "/headers") { response.flushHeaders(); response.destroy(); return; }
  if (path === "/twice") { response.destroy(); response.destroy(new Error("ignored")); return; }
  if (path === "/cancel") { streamUntilCancelled(response); return; }
  if (path === "/output-error") {
    response.write("first\n");
    setTimeout(() => response.destroy(new Error("deliberate output error")), 30);
    return;
  }
  response.statusCode = 404;
  response.end("missing");
});
server.on("clientError", error => errors.push(error.message));
server.listen(Number(process.env.PORT), "127.0.0.1", () => console.log("HTTP_LIFECYCLE_READY"));
