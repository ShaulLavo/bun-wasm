import { requestCopyContract } from "./contract.ts";

console.log(await requestCopyContract());
const base = process.env.TEST_SERVER;
if (!base) throw new Error("Missing test server");
const body = new ReadableStream({
  start(controller) {
    controller.enqueue(new TextEncoder().encode("fetch payload"));
    controller.close();
  },
});
const init = { method: "POST", body, redirect: "manual", duplex: "half" } satisfies RequestInit & { duplex: "half" };
const source = new Request(`${base}/echo`, init);
const response = await fetch(source, { headers: { "x-copy": "yes" } });
const result = await response.json();
if (result.body !== "fetch payload" || result.method !== "POST" || result.headers["x-copy"] !== "yes") {
  throw new Error(`Request copy fetch mismatch: ${JSON.stringify(result)}`);
}
console.log("request copy fetch");

const redirectSource = new Request(`${base}/redirect`, { redirect: "manual" });
const redirectResponse = await fetch(redirectSource, { headers: { "x-copy": "redirect" } });
if (redirectResponse.status !== 302 || redirectResponse.redirected) throw new Error("Request copy followed a manual redirect");
console.log("request copy redirect");
