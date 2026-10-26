import assert from "node:assert/strict";

const messages: string[] = [];
const states: string[] = [];
const server = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  fetch(request, server) {
    if (server.upgrade(request, { data: "typed peer" })) return;
    return new Response("not upgraded", { status: 400 });
  },
  websocket: {
    open(socket) {
      assert.equal(socket.data, "typed peer");
      assert.equal(socket.readyState, 1);
      socket.subscribe("fixture");
      assert.equal(socket.isSubscribed("fixture"), true);
    },
    message(socket, data) { socket.send(data); },
  },
});
try {
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/fixture`);
  assert.equal(socket.readyState, 0);
  assert.throws(() => socket.send("before open"));
  socket.binaryType = "arraybuffer";
  await new Promise<void>((resolve, reject) => {
    socket.onerror = () => reject(new Error("fixture socket failed"));
    socket.onopen = () => {
      states.push(`open:${socket.readyState}`);
      socket.send("text");
      socket.send(new Blob(["blob"]));
      socket.send(Uint8Array.of(0, 255));
    };
    socket.onmessage = ({ data }) => {
      messages.push(typeof data === "string" ? data : Array.from(new Uint8Array(data)).join(","));
      if (messages.length === 3) socket.close(1000, "fixture done");
    };
    socket.onclose = event => {
      assert.equal(event.code, 1000);
      assert.equal(event.reason, "fixture done");
      assert.equal(event.wasClean, true);
      states.push(`close:${socket.readyState}`);
      resolve();
    };
  });
  assert.deepEqual(messages, ["text", "98,108,111,98", "0,255"]);
  assert.deepEqual(states, ["open:1", "close:3"]);
  console.log("ordered text, Blob and bytes; open and clean close states");
} finally {
  await server.stop(true);
}
