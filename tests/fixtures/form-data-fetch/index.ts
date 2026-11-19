// FormData request bodies go out as multipart through every fetch() argument
// shape, a server parses them with req.formData(), and a multipart response
// parses back with res.formData().
function show(form: FormData): string {
  return JSON.stringify(Array.from(form, ([name, value]) =>
    typeof value === "string" ? [name, value] : [name, { file: value.name, type: value.type }]));
}

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const type = req.headers.get("content-type") ?? "";
    if (new URL(req.url).pathname === "/echo") return new Response(await req.arrayBuffer(), { headers: { "content-type": type } });
    const form = await req.formData();
    const files: string[] = [];
    for (const [name, value] of form) if (typeof value !== "string") files.push(`${name}=${await value.text()}`);
    return Response.json({ multipart: type.startsWith("multipart/form-data; boundary="), form: show(form), files });
  },
});

function sample(): FormData {
  const form = new FormData();
  form.append("field", "value\nline");
  form.append("upload", new File(["file body"], "notes.txt", { type: "text/plain" }));
  form.append("blob", new Blob(["asd1"]), "blob.bin");
  return form;
}

try {
  const base = server.url.href;
  console.log("url and init", JSON.stringify(await (await fetch(base, { method: "POST", body: sample() })).json()));
  console.log("plain object", JSON.stringify(await (await fetch({ url: base, method: "PUT", body: sample() } as unknown as string)).json()));
  const request = new Request(base, { method: "POST", body: sample() });
  console.log("request", JSON.stringify(await (await fetch(request)).json()));
  console.log("request with init", JSON.stringify(await (await fetch(new Request(base, { method: "POST" }), { body: sample() })).json()));
  const echoed = await fetch(new URL("/echo", base), { method: "POST", body: sample() });
  const parsed = await echoed.formData();
  console.log("echoed multipart", show(parsed), await (parsed.get("upload") as File).text());
  const urlencoded = await fetch(new URL("/echo", base), { method: "POST", body: new URLSearchParams({ a: "1", b: "two words" }) });
  console.log("echoed urlencoded", show(await urlencoded.formData()));
} finally {
  server.stop(true);
}
