import assert from "node:assert/strict";
import net from "node:net";

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const event = (target, name) => new Promise(resolve => target.once(name, resolve));
const control = path => fetch(process.env.TEST_SERVER + path).then(response => response.text());
const resources = [];
function own(socket) {
  resources.push(socket);
  socket.on("error", () => {});
  return socket;
}
async function until(check, message) {
  for (let i = 0; i < 1000; i++) {
    if (check()) return;
    await delay(5);
  }
  assert.fail(message);
}
async function listen(callback) {
  const server = net.createServer(callback);
  resources.push(server);
  server.listen(0, "127.0.0.1");
  await event(server, "listening");
  return server;
}
function connect(server, highWaterMark = 1024) {
  return own(net.connect({ host: "127.0.0.1", port: server.address().port, highWaterMark }));
}
async function cleanup() {
  for (const resource of resources.splice(0).reverse()) {
    if (resource instanceof net.Socket) resource.destroy();
    else resource.close();
  }
  await control("/tcp-sink/close");
  await delay(10);
}
async function fanout(mode) {
  const { port } = JSON.parse(await control("/tcp-sink"));
  const slow = own(net.connect({ host: "127.0.0.1", port, highWaterMark: 1024 }));
  await event(slow, "connect");
  let received = 0;
  const fastServer = await listen(socket => own(socket).on("data", chunk => { received += chunk.length; }));
  const fast = connect(fastServer);
  await event(fast, "connect");
  let producer;
  const initial = 16 * 1024 * 1024;
  const tail = 1024 * 1024;
  const sender = await listen(socket => { producer = own(socket); producer.write(Buffer.alloc(initial, 120)); });
  const source = connect(sender, 65536);
  let maximum = 0;
  let slowWrites = 0;
  let blockedFastDrains = 0;
  const write = slow.write.bind(slow);
  slow.write = chunk => {
    slowWrites++;
    const accepted = write(chunk);
    maximum = Math.max(maximum, slow.writableLength);
    return accepted;
  };
  source.pipe(slow);
  source.pipe(fast);
  fast.on("drain", () => {
    if (slow._conn.bufferedAmount > 0 && slow.writableNeedDrain) blockedFastDrains++;
  });
  await until(() => blockedFastDrains > 0, "fast must drain while the native slow peer blocks writes");
  await delay(50);
  assert.ok(slow._conn.bufferedAmount > 0, "native peer is still paused");
  if (mode === "drain") {
    assert.ok(maximum <= slow.writableHighWaterMark + 65536, "fast drain cannot grow the blocked slow queue, maximum=" + maximum);
    assert.equal(source.isPaused(), true, "fast drain cannot resume a source still awaiting slow");
    const read = source.bytesRead;
    await delay(40);
    assert.ok(source.bytesRead - read <= 65536, "source stops reading while one destination remains blocked");
    assert.ok(source.readableLength <= source.readableHighWaterMark + 65536);
    await control("/tcp-sink/resume");
  } else if (mode === "unpipe") {
    assert.equal(source.unpipe(slow), source);
    assert.equal(slow.listenerCount("drain"), 0);
  } else {
    slow.destroy();
    await event(slow, "close");
    assert.equal(slow.listenerCount("drain"), 0);
  }
  const detachedWrites = slowWrites;
  producer.end(Buffer.alloc(tail, 121));
  await until(() => received === initial + tail, "remaining fast destination must receive all bytes after release");
  await until(() => source.readableEnded, "source must finish after the last blocked destination releases");
  if (mode !== "drain") assert.equal(slowWrites, detachedWrites, "detached destination receives no more writes");
  assert.equal(source.listenerCount("data"), 0, "finished pipes remove forwarding listeners");
  assert.equal(fast.listenerCount("drain"), 1, "finished pipe removes only its own drain listener");
}

let failures = 0;
for (const mode of ["drain", "unpipe", "destroy"]) {
  try {
    await fanout(mode);
    console.log("PASS fanout " + mode);
  } catch (error) {
    failures++;
    console.log("FAIL fanout " + mode + " " + error.message.split("\n")[0]);
  } finally {
    await cleanup();
  }
}
assert.equal(failures, 0, "multi-destination TCP pipe regressions");
