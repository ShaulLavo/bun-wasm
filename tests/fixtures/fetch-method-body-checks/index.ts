// Bun lets a GET or HEAD Request carry a body, and fetch() refuses to send one. For s3:// URLs,
// fetch() checks the body, the s3 options, the credentials and the method before signing.
// Every fetch() here rejects before any network use.
for (const name of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"]) delete process.env[name];

const describe = (error: unknown) => {
  const e = error as Error & { code?: string };
  return `${e.name} ${e.code ?? "(no code)"}: ${e.message}`;
};

for (const method of ["GET", "HEAD", "get"]) {
  const request = new Request("http://example.com/", { method, body: "hi" });
  console.log(`${method} Request with a body:`, request.method, JSON.stringify(await request.text()));
}
const copy = new Request(new Request("http://example.com/", { method: "POST", body: "copied" }), { method: "GET" });
console.log("a POST Request copied as GET keeps its body:", copy.method, JSON.stringify(await copy.text()));

const attempts: [string, () => Promise<Response>][] = [
  ["fetch(GET Request with a body)", () => fetch(new Request("http://127.0.0.1:1/", { method: "GET", body: "x" }))],
  ["fetch(HEAD Request with a stream)", () => fetch(new Request("http://127.0.0.1:1/", { method: "HEAD", body: new Response("s").body }))],
  ["fetch(POST Request, { method: GET })", () => fetch(new Request("http://127.0.0.1:1/", { method: "POST", body: "x" }), { method: "GET" })],
  ["fetch(url, { method: HEAD, body })", () => fetch("http://127.0.0.1:1/", { method: "HEAD", body: "x" })],
  ["s3: DELETE with a stream body", () => fetch("s3://bucket/key", { method: "DELETE", body: new ReadableStream() })],
  ["s3: PATCH with a stream body", () => fetch("s3://bucket/key", { method: "PATCH", body: new ReadableStream() })],
  ["s3: GET with a stream body", () => fetch("s3://bucket/key", { method: "GET", body: new ReadableStream() })],
  ["s3: accessKeyId of the wrong type", () => fetch("s3://bucket/key", { method: "PUT", body: "x", s3: { accessKeyId: 1 } } as RequestInit)],
  ["s3: no credentials", () => fetch("s3://bucket/key", { method: "DELETE", body: "x" })],
  ["s3: PATCH without credentials", () => fetch("s3://bucket/key", { method: "PATCH" })],
  ["s3: PATCH with credentials", () => fetch("s3://bucket/key", { method: "PATCH", s3: { accessKeyId: "a", secretAccessKey: "b" } } as RequestInit)],
];
for (const [label, attempt] of attempts) {
  let promise: Promise<Response>;
  try {
    promise = attempt();
  } catch (error) {
    console.log(label, "throws", describe(error));
    continue;
  }
  console.log(label, await promise.then(() => "resolves", error => `rejects ${describe(error)}`));
}
