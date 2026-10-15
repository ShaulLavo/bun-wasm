import assert from "node:assert/strict";
let serverClosed;
const closed = new Promise((resolve) => { serverClosed = resolve; });
const server = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  fetch(req, srv) {
    if (srv.upgrade(req, { data: { path: new URL(req.url).pathname } })) return;
    return new Response("ordinary HTTP");
  },
  websocket: {
    open(ws) {
      assert.equal(ws.data.path, "/socket");
      ws.subscribe("room");
      ws.send("hello");
    },
    message(ws, data) {
      if (data === "publish") { ws.publish("room", "excluded"); server.publish("room", "published"); return; }
      ws.send(data);
    },
    close() { serverClosed(); },
  },
});
try {
  console.log("http:", await (await fetch(server.url)).text());
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/socket`);
  ws.binaryType = "arraybuffer";
  const done = new Promise((resolve, reject) => {
    ws.onerror = reject;
    let stage = 0;
    ws.onmessage = (event) => {
      assert(event instanceof MessageEvent);
      const { data } = event;
      if (stage++ === 0) {
        assert.equal(data, "hello");
        console.log("connected:", ws.readyState, server.pendingWebSockets, server.subscriberCount("room"));
        ws.send(new Uint8Array([0, 1, 254, 255]));
      } else if (stage === 2) {
        console.log("binary:", Array.from(new Uint8Array(data)).join(","));
        ws.send("x".repeat(70000));
      } else if (stage === 3) {
        console.log("large:", data.length);
        ws.send("publish");
      } else {
        assert.equal(data, "published");
        console.log("pubsub:", data);
        ws.close(1000, "done");
      }
    };
    ws.onclose = (event) => {
      assert(event instanceof CloseEvent);
      console.log("client closed:", event.code, event.reason, event.wasClean);
      resolve();
    };
  });
  await done;
  assert.equal(ws.readyState, WebSocket.CLOSED);
  await closed;
  await Bun.sleep(5);
  console.log("closed:", server.pendingWebSockets, server.subscriberCount("room"));
} finally { await server.stop(true); }

// A native host server also checks client masking and accept-key validation.
const host = new WebSocket(process.env.TEST_SERVER.replace("http:", "ws:") + "/websocket");
await new Promise((resolve, reject) => {
  host.onerror = reject;
  host.onopen = () => host.send("native host echo");
  host.onmessage = ({ data }) => {
    console.log("host:", data);
    host.ping(new Blob(["PING"]));
  };
  host.addEventListener("pong", async (event) => {
    assert(event instanceof MessageEvent);
    assert(event.data instanceof Blob);
    console.log("host pong:", await event.data.text());
    host.close(1000);
  }, { once: true });
  host.onclose = resolve;
});
