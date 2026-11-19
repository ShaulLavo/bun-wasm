// A null body is not a zero-length body: every read of it gives an empty result
// and nothing uses it up, so bodyUsed stays false and clone() keeps working. That
// holds for a Request or Response made without a body, Response.redirect() and
// Response.error(), and a fetch() Response to HEAD or with a null body status.
const settled = (promise: Promise<unknown>) =>
  promise.then(value => `ok ${value instanceof Blob ? `Blob(${value.size})` : ArrayBuffer.isView(value) ? `bytes(${value.byteLength})` : value instanceof ArrayBuffer ? `ArrayBuffer(${value.byteLength})` : JSON.stringify(value)}`, error => (error as Error).constructor.name);
const errorName = (fn: () => unknown) => {
  try {
    fn();
    return "ok";
  } catch (error) {
    return `${(error as Error).constructor.name}: ${(error as Error).message}`;
  }
};

async function reads(owner: Request | Response): Promise<string> {
  const results: string[] = [];
  for (const method of ["text", "arrayBuffer", "bytes", "blob", "json", "text"] as const) {
    results.push(`${method}=${await settled(owner[method]())} used=${owner.bodyUsed}`);
  }
  return `${results.join(" ")} body=${owner.body} clone=${errorName(() => owner.clone())}`;
}

const made: [string, () => Request | Response][] = [
  ["new Response()", () => new Response()],
  ["new Response(null)", () => new Response(null)],
  ["new Response(undefined)", () => new Response(undefined)],
  ["new Request(url)", () => new Request("http://a/")],
  ['new Request(url, { method: "POST" })', () => new Request("http://a/", { method: "POST" })],
  ['new Request(url, { method: "POST", body: null })', () => new Request("http://a/", { method: "POST", body: null })],
  ["Response.redirect()", () => Response.redirect("http://a/")],
  ["Response.error()", () => Response.error()],
];
for (const [name, make] of made) console.log(`${name}: ${await reads(make())}`);
for (const response of [Response.error(), Response.redirect("http://a/", 307)]) {
  const copy = response.clone();
  console.log(`${response.type} clone(): type=${copy.type} status=${copy.status} ok=${copy.ok} location=${copy.headers.get("location")} body=${copy.body}`);
}

const form = new Response(null, { headers: { "content-type": "application/x-www-form-urlencoded" } });
console.log("null body formData():", JSON.stringify(Array.from(await form.formData())), `used=${form.bodyUsed}`);
const stream = new Response(null);
console.log("null body textStream():", JSON.stringify(await new Response(stream.textStream()).text()), `used=${stream.bodyUsed}`);

// A zero-length body is still a body: reading it uses it up.
const empty = new Response("");
await empty.text();
console.log('new Response(""):', `used=${empty.bodyUsed} again=${await settled(empty.text())} clone=${errorName(() => empty.clone())}`);

// Answers the one request it gets with `answer`, once the request head is in.
function listen(answer: string) {
  return Bun.listen<{ request: string }>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(socket) {
        socket.data = { request: "" };
      },
      data(socket, data) {
        socket.data.request += data.toString("latin1");
        if (socket.data.request.includes("\r\n\r\n")) socket.end(answer);
      },
    },
  });
}
const answers: [string, string, RequestInit | undefined][] = [
  ["204", "HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n", undefined],
  ["205", "HTTP/1.1 205 Reset Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n", undefined],
  ["205 with content", "HTTP/1.1 205 Reset Content\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello", undefined],
  ["304", 'HTTP/1.1 304 Not Modified\r\nETag: "x"\r\nConnection: close\r\n\r\n', undefined],
  ["200 to HEAD", "HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\n", { method: "HEAD" }],
  ["200 with empty content", "HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n", undefined],
];
for (const [name, answer, init] of answers) {
  const listener = listen(answer);
  try {
    const response = await fetch(`http://127.0.0.1:${listener.port}/`, init);
    const body = response.body === null ? "null" : "stream";
    console.log(`fetch ${name}: status=${response.status} content-length=${response.headers.get("content-length")} body=${body} ${await reads(response)}`);
  } finally {
    listener.stop(true);
  }
}
