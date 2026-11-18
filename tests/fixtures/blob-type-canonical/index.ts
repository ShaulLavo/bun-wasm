// Blob and File types: an exact match of a few known types gets Bun's canonical value
// (with a charset); every other type is lowercased and kept as given.
const types = ["text/plain", "TEXT/PLAIN", "Text/Html", "text/html", "text/css", "text/javascript", "text/jsx", "application/javascript", "application/json", "application/x-www-form-urlencoded", "application/webassembly", "text/csv", "text/markdown", "text/xml", "text/x-custom", "text/plain;charset=latin1", "text/plain; charset=utf-8", "text/html;foo=bar", "application/xml", "image/svg+xml", "image/vnd.microsoft.icon", "application/octet-stream", "text/", "text", "", "  "];
for (const type of types) {
  console.log(JSON.stringify(type), "->", JSON.stringify(new Blob(["a"], { type }).type), JSON.stringify(new File(["a"], "f", { type }).type));
}

// A body's blob() takes its Content-Type through the same rule.
for (const contentType of ["text/x-custom", "text/plain", "TEXT/PLAIN", "application/json"]) {
  const blob = await new Response("x", { headers: { "content-type": contentType } }).blob();
  console.log("response", JSON.stringify(contentType), "->", JSON.stringify(blob.type));
}
console.log("string body", JSON.stringify((await new Response("x").blob()).type));
console.log("slice", JSON.stringify(new Blob(["abc"]).slice(0, 1, "text/plain").type), JSON.stringify(new Blob(["abc"]).slice(0, 1, "Text/X-Thing").type));
