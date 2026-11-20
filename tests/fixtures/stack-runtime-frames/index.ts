// error.stack lists the program's own frames, as in Bun: never the runtime's internal frames
// (its event loop, module loader, EventEmitter, fs, streams or http code), nor the native
// calls the runtime makes to run a callback.
import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import { pipeline, Readable, Transform, Writable } from "node:stream";

const root = import.meta.dir;
const prefix = root.endsWith("/") ? root : `${root}/`;

// Bun's own JavaScript builtins (node:events, internal:streams/*, its microtask runner) carry
// build-specific positions; leave them out of the comparison and keep every other frame.
function show(label: string, error: Error) {
  const lines = String(error.stack).split(prefix).join("./").split("\n");
  const kept = lines.filter(line => !/^\s+at .*\((?:node|internal|native):[^()]*\d+:\d+\)$/.test(line));
  console.log(`--- ${label}\n${kept.join("\n")}`);
}

show("top level", new Error("top"));

function named() {
  show("plain call", new Error("call"));
}
named();

const require = createRequire(import.meta.url);
show("CommonJS function", require("./make.cts").make());

const emitter = new EventEmitter();
emitter.on("go", () => show("EventEmitter listener", new Error("emit")));
emitter.emit("go");

await new Promise<void>(resolve => setTimeout(() => {
  show("timer", new Error("timer"));
  resolve();
}, 1));

await new Promise<void>(resolve => setImmediate(() => {
  show("immediate", new Error("immediate"));
  resolve();
}));

await new Promise<void>(resolve => process.nextTick(() => {
  show("nextTick", new Error("tick"));
  resolve();
}));

await new Promise<void>(resolve => queueMicrotask(() => {
  show("microtask", new Error("microtask"));
  resolve();
}));

await Promise.resolve().then(() => show("promise callback", new Error("then")));

await new Promise<void>(resolve => fs.readFile(import.meta.path, () => {
  show("fs callback", new Error("fs"));
  resolve();
}));

await new Promise<void>(resolve => {
  const upper = new Transform({
    transform(chunk, _encoding, callback) {
      show("stream pipeline", new Error("transform"));
      callback(null, chunk);
    },
  });
  const sink = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  pipeline(Readable.from(["a"]), upper, sink, () => resolve());
});

await new Promise<void>(resolve => {
  const server = http.createServer((_request, response) => {
    show("http handler", new Error("http"));
    response.end("ok");
  });
  server.listen(0, "127.0.0.1", async () => {
    const { port } = server.address() as { port: number };
    await fetch(`http://127.0.0.1:${port}/`).then(response => response.text());
    server.close(() => resolve());
  });
});

// Tests run by `bun test` show only the test file's frames.
const tests = Bun.spawnSync([process.execPath, "test", "./stack.test.ts"], {
  cwd: root, stdout: "pipe", stderr: "pipe", env: { ...process.env, AGENT: "0", NO_COLOR: "1" },
});
const testOutput = tests.stdout.toString().trim().split("\n").filter(line => !line.startsWith("bun test "));
console.log(`--- bun test (exit ${tests.exitCode})\n${testOutput.join("\n")}`);
