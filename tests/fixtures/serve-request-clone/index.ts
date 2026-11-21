// Clones of bodies that arrive over the network, as Bun treats them: a read on the clone of a
// Bun.serve request rejects when the body stops coming, and both branches of a fetch() body
// clone get the same chunk objects. A Bun.connect() socket closes with `using`.

// The handler clones a request whose announced body never comes, then the response goes out
// first or the client goes away first. The clone's read rejects either way.
for (const park of [false, true]) {
  let state = "handler not reached";
  const settled = Promise.withResolvers<void>();
  await using server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      state = "pending";
      req.clone().text().then(
        text => (state = `resolved: ${JSON.stringify(text)}`),
        error => (state = `rejected: ${error?.name}: ${error?.message}`),
      ).finally(() => settled.resolve());
      return park ? new Promise<Response>(() => {}) : new Response("k");
    },
  });
  const received = Promise.withResolvers<string>();
  let data = "";
  {
    using socket = await Bun.connect({
      hostname: "127.0.0.1",
      port: server.port!,
      socket: {
        data(_socket, chunk) {
          data += chunk.toString();
          if (data.endsWith("\r\n\r\nk")) received.resolve(data);
        },
        close() {
          received.resolve(data);
        },
      },
    });
    socket.write("POST /upload HTTP/1.1\r\nHost: example.com\r\nContent-Type: text/plain\r\nContent-Length: 5\r\n\r\n");
    if (!park) console.log("response ends first:", (await received.promise).split("\r\n")[0]);
    else while (state === "handler not reached") await Bun.sleep(5);
    // Leaving the block disposes the socket, which ends the connection.
  }
  await settled.promise;
  console.log(park ? "client goes away first:" : "  then the clone's read:", state);
}

// A fetch() body and its clone, read in lockstep, see the same chunk objects.
{
  const total = 1024 * 1024;
  const chunk = new Uint8Array(64 * 1024).fill(42);
  await using server = Bun.serve({
    port: 0,
    fetch() {
      let sent = 0;
      return new Response(new ReadableStream({
        pull(controller) {
          if (sent >= total) return controller.close();
          controller.enqueue(chunk);
          sent += chunk.byteLength;
        },
      }));
    },
  });
  const response = await fetch(server.url);
  const clone = response.clone();
  const original = response.body!.getReader();
  const copy = clone.body!.getReader();
  let bytes = 0;
  let shared = true;
  for (;;) {
    const [a, b] = await Promise.all([original.read(), copy.read()]);
    if (a.done || b.done) {
      console.log("both branches end together:", a.done && b.done);
      break;
    }
    shared &&= a.value === b.value;
    bytes += a.value.byteLength;
  }
  console.log("fetch clone shares chunks:", shared, "bytes:", bytes);
}

// A byte stream the program made is teed by the standard: the clone gets its own copy.
for (const type of ["bytes", undefined] as const) {
  const chunk = new Uint8Array([1, 2, 3]);
  const response = new Response(new ReadableStream({ type, start(controller) { controller.enqueue(chunk); controller.close(); } }));
  const clone = response.clone();
  const [a, b] = await Promise.all([response.body!.getReader().read(), clone.body!.getReader().read()]);
  console.log(`clone of a user ${type ?? "default"} stream shares the chunk:`, a.value === b.value, Array.from(b.value!));
}
