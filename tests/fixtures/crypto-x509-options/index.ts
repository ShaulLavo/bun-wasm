import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
const cert = new X509Certificate(readFileSync(new URL("./names.pem", import.meta.url)));
const emailOnly = new X509Certificate(readFileSync(new URL("./email-only.pem", import.meta.url)));
let failures = 0;
function check(name: string, test: () => void) {
  try { test(); console.log("PASS", name); }
  catch (error) { failures++; console.log("FAIL", name, String(error)); }
}
check("wildcards", () => {
  assert.equal(cert.checkHost("a.example.com"), "*.example.com");
  assert.equal(cert.checkHost("a.example.com", { wildcards: false }), undefined);
  assert.equal(cert.checkHost("a.b.example.com"), undefined);
});
check("multiLabelWildcards", () => {
  assert.equal(cert.checkHost("a.b.example.com", { multiLabelWildcards: true }), "*.example.com");
  assert.equal(cert.checkHost("a.b.example.com", { multiLabelWildcards: false }), undefined);
  assert.equal(cert.checkHost("a.b.example.com", { multiLabelWildcards: true, wildcards: false }), undefined);
});
check("partialWildcards", () => {
  assert.equal(cert.checkHost("www.partial.test"), "w*.partial.test");
  assert.equal(cert.checkHost("www.partial.test", { partialWildcards: true }), "w*.partial.test");
  assert.equal(cert.checkHost("www.partial.test", { partialWildcards: false }), undefined);
  assert.equal(cert.checkHost("a.example.com", { partialWildcards: false }), "*.example.com");
});
check("subject", () => {
  assert.equal(cert.checkHost("fallback.example.net"), undefined);
  assert.equal(cert.checkHost("fallback.example.net", { subject: "default" }), undefined);
  assert.equal(cert.checkHost("fallback.example.net", { subject: "always" }), "fallback.example.net");
  assert.equal(cert.checkHost("fallback.example.net", { subject: "never" }), undefined);
  assert.equal(emailOnly.checkHost("fallback.example.net"), "fallback.example.net");
  assert.equal(emailOnly.checkHost("fallback.example.net", { subject: "never" }), undefined);
});
check("singleLabelSubdomains", () => {
  assert.equal(cert.checkHost(".example.org"), "deep.a.example.org");
  assert.equal(cert.checkHost(".example.org", { singleLabelSubdomains: false }), "deep.a.example.org");
  assert.equal(cert.checkHost(".example.org", { singleLabelSubdomains: true }), undefined);
  assert.equal(cert.checkHost(".a.example.org", { singleLabelSubdomains: true }), "deep.a.example.org");
  assert.equal(cert.checkHost(".example.org", { wildcards: false }), "deep.a.example.org");
});
check("standalone issuer", () => {
  assert.equal(cert.checkIssued(cert), true);
  assert.equal(cert.issuerCertificate, undefined);
  assert.equal(new X509Certificate(cert.raw).issuerCertificate, undefined);
});
assert.equal(failures, 0);
