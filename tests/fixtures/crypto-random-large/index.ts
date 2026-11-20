// crypto.getRandomValues fills views of any size, as Bun does; the Web
// Crypto spec's 65536-byte QuotaExceededError does not apply. Large random
// buffers then work as Request and Response bodies, SharedArrayBuffer included.
for (const size of [0, 1, 65536, 65537, 1_000_000]) {
  const bytes = crypto.getRandomValues(new Uint8Array(size));
  const tail = bytes.subarray(Math.max(0, size - 4096));
  console.log(size, bytes.length, size < 4096 || tail.some(b => b !== 0));
}
const words = new Uint32Array(300_000);
console.log("same view", crypto.getRandomValues(words) === words, words.some(w => w !== 0));
const view = new Uint8Array(new ArrayBuffer(200_000), 100, 150_000);
crypto.getRandomValues(view);
console.log("offset view", view.byteOffset, view.some(b => b !== 0), new Uint8Array(view.buffer, 0, 100).every(b => b === 0));
for (const make of [() => new Float32Array(4), () => new Float64Array(100_000), () => new DataView(new ArrayBuffer(8))]) {
  try {
    crypto.getRandomValues(make() as unknown as Uint8Array);
  } catch (error) {
    console.log((error as Error).name, (error as Error).message);
  }
}

// A large body round-trips through Request and Response.
const body = crypto.getRandomValues(new Uint8Array(1_000_000));
const echoed = new Uint8Array(await new Response(body).arrayBuffer());
console.log("response body", echoed.length, echoed.every((b, i) => b === body[i]));
const posted = new Uint8Array(await new Request("http://localhost/", { method: "POST", body }).arrayBuffer());
console.log("request body", posted.length, posted.every((b, i) => b === body[i]));

// A SharedArrayBuffer body is its bytes, at any size.
for (const size of [0, 3, 1_000_000]) {
  const shared = new SharedArrayBuffer(size);
  crypto.getRandomValues(new Uint8Array(shared));
  const copy = new Uint8Array(await new Response(shared).arrayBuffer());
  const request = new Request("http://localhost/", { method: "POST", body: shared });
  const same = copy.length === size && copy.every((b, i) => b === new Uint8Array(shared)[i]);
  console.log("shared body", size, same, (await request.arrayBuffer()).byteLength, new Response(shared).headers.get("content-type"));
}
