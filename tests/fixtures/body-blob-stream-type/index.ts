// A body built from a Blob's stream keeps the Blob's type, as Bun lifts the Blob back out
// of the stream; a stream with no Blob behind it has no type.
const blob = new Blob(["bye"], { type: "text/x-bun" });

for (const [label, make] of [
  ["Response", (body: BodyInit) => new Response(body)],
  ["Request", (body: BodyInit) => new Request("http://localhost/", { method: "POST", body, duplex: "half" } as RequestInit)],
] as const) {
  const fromStream = make(blob.stream());
  console.log(label, "content-type:", fromStream.headers.get("content-type"));
  const read = await fromStream.blob();
  console.log(label, "blob():", JSON.stringify([read.type, await read.text()]));

  const fromBody = make(make(blob).body!);
  console.log(label, "around .body:", JSON.stringify((await fromBody.blob()).type));

  const plain = make(new ReadableStream({ start: c => { c.enqueue(new TextEncoder().encode("js")); c.close(); } }));
  console.log(label, "JS stream:", JSON.stringify([plain.headers.get("content-type"), (await plain.blob()).type]));

  const sliced = make(blob.slice(0, 2, "text/x-slice").stream());
  console.log(label, "slice stream:", JSON.stringify((await sliced.blob()).type));
}

const cloned = new Response(blob.stream()).clone();
console.log("clone:", JSON.stringify((await cloned.blob()).type));
