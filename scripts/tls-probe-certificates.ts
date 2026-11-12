import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function createProbeCertificates(root: string) {
  mkdirSync(root, { mode: 0o700 });
  const executable = Bun.which("openssl");
  if (!executable) throw new Error("OpenSSL is required to generate private TLS test fixtures");
  const openssl = (args: readonly string[]) => execFileSync(executable, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"], timeout: 15_000 });
  for (const name of ["ca", "unknown"]) openssl([
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", `${name}.key`, "-out", `${name}.pem`, "-subj", `/CN=TLS Probe ${name}`, "-days", "2",
    "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign",
  ]);
  openssl(["req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", "leaf.key", "-out", "leaf.csr", "-subj", "/CN=tls-probe.test"]);
  writeFileSync(join(root, "extensions.cnf"), "[server]\nsubjectAltName=DNS:tls-probe.test\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n");
  openssl(["x509", "-req", "-in", "leaf.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", "leaf.pem", "-days", "2", "-extfile", "extensions.cnf", "-extensions", "server"]);
  writeFileSync(join(root, "index"), "");
  writeFileSync(join(root, "serial"), "1000\n");
  writeFileSync(join(root, "openssl.cnf"), "[ca]\ndefault_ca=default\n[default]\ndatabase=index\nserial=serial\nnew_certs_dir=.\ncertificate=ca.pem\nprivate_key=ca.key\ndefault_md=sha256\npolicy=policy\n[policy]\ncommonName=supplied\n");
  openssl(["ca", "-batch", "-config", "openssl.cnf", "-startdate", "20200101000000Z", "-enddate", "20200102000000Z", "-in", "leaf.csr", "-out", "expired.pem", "-extfile", "extensions.cnf", "-extensions", "server"]);
  return { root, ca: "ca.pem", unknown: "unknown.pem", key: join(root, "leaf.key"), cert: join(root, "leaf.pem"), expired: join(root, "expired.pem") };
}
