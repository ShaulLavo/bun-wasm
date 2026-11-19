// ReadableStream's text/json/bytes/blob, Bun.readableStreamToArray and Body.textStream().
const encode = (text: string) => new TextEncoder().encode(text);

function bytesStream(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function stringStream(...chunks: string[]): ReadableStream<string> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

const failure = (error: unknown) => {
  const value = error as { name?: string; code?: string; message?: string };
  if (value?.name === "SyntaxError") return "SyntaxError";
  return `${value?.name} ${value?.code ?? ""} ${value?.message}`;
};

const proto = ReadableStream.prototype as unknown as Record<string, unknown>;
console.log("methods", ["text", "json", "bytes", "blob"].map(name => `${name}:${typeof proto[name]}:${(proto[name] as Function).length}`).join(" "));

console.log("text", JSON.stringify(await bytesStream(encode("hello "), encode("world")).text()));
console.log("text split", JSON.stringify(await bytesStream(new Uint8Array([0xf0, 0x9f]), new Uint8Array([0xab, 0xa0])).text()));
console.log("text strings", JSON.stringify(await stringStream("a", "b").text()));
console.log("json", JSON.stringify(await bytesStream(encode('{"a":'), encode("[1,2]}")).json()));
const bytes = await bytesStream(encode("ab"), encode("c")).bytes();
console.log("bytes", bytes.constructor.name, Array.from(bytes).join(","));
const blob = await bytesStream(encode("xy"), encode("z")).blob();
console.log("blob", blob instanceof Blob, blob.size, JSON.stringify(blob.type), await blob.text());

const locked = bytesStream(encode("x"));
locked.getReader();
await locked.text().then(() => console.log("locked resolved"), error => console.log("locked rejects", failure(error)));
await new Promise<void>(resolve => {
  try {
    proto.text.call({});
    console.log("non-stream returned");
  } catch (error) {
    console.log("non-stream throws", failure(error));
  }
  resolve();
});
await bytesStream(encode("{")).json().then(() => console.log("bad json resolved"), error => console.log("bad json rejects", failure(error)));

const array = await Bun.readableStreamToArray(stringStream("p", "q"));
console.log("toArray", Array.isArray(array), JSON.stringify(array));
const byteArray = await Bun.readableStreamToArray(bytesStream(encode("m"), encode("n")));
console.log("toArray bytes", byteArray.length, byteArray.map(chunk => chunk.constructor.name).join(","));
console.log("toArray empty", JSON.stringify(await Bun.readableStreamToArray(stringStream())));

async function textChunks(stream: ReadableStream<string>): Promise<string> {
  const chunks = await Array.fromAsync(stream);
  return `${chunks.every(chunk => typeof chunk === "string")} ${JSON.stringify(chunks.join(""))}`;
}

for (const [label, make] of [
  ["Response", (body?: BodyInit | null) => new Response(body)],
  ["Request", (body?: BodyInit | null) => new Request("http://localhost/", { method: "POST", body })],
] as const) {
  const textStream = (body?: BodyInit | null) => (make(body) as Response & { textStream(): ReadableStream<string> }).textStream();
  console.log(label, "typeof", typeof (make() as unknown as Record<string, unknown>).textStream);
  console.log(label, "undefined", await textChunks(textStream()));
  console.log(label, "null", await textChunks(textStream(null)));
  console.log(label, "string", await textChunks(textStream("héllo")));
  console.log(label, "buffer", await textChunks(textStream(encode("bytes ✓"))));
  console.log(label, "stream", await textChunks(textStream(bytesStream(new Uint8Array([0xf0, 0x9f]), new Uint8Array([0xab, 0xa0])))));
  const body = make("once") as Response & { textStream(): ReadableStream<string> };
  const first = body.textStream();
  console.log(label, "used", body.bodyUsed, first instanceof ReadableStream);
  await textChunks(first);
  try {
    const second = body.textStream();
    await Array.fromAsync(second).then(() => console.log(label, "second resolved"), error => console.log(label, "second rejects", failure(error)));
  } catch (error) {
    console.log(label, "second throws", failure(error));
  }
}
