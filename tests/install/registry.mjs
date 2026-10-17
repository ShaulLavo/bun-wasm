import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { gzipSync } from "node:zlib";

export function tarEntry(path, content, type = "0", link = "") {
  const bytes = Buffer.from(content);
  const header = Buffer.alloc(512);
  header.write(path, 0, 100);
  header.write("0000644\0", 100);
  header.write("0000000\0", 108);
  header.write("0000000\0", 116);
  header.write(`${bytes.length.toString(8).padStart(11, "0")}\0`, 124);
  header.write("00000000000\0", 136);
  header.fill(32, 148, 156);
  header.write(type, 156);
  header.write(link, 157, 100);
  header.write("ustar\0", 257);
  header.write("00", 263);
  const sum = header.reduce((total, byte) => total + byte, 0);
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return Buffer.concat([header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512)]);
}

export function packageFixture(name, version, extra = {}, source, entries = []) {
  const manifest = { name, version, main: "index.js", ...extra };
  const files = [tarEntry("package/package.json", JSON.stringify(manifest)), tarEntry("package/index.js", source ?? `module.exports = ${JSON.stringify(`${name}@${version}`)};\n`)];
  const archive = gzipSync(Buffer.concat(files.concat(entries, [Buffer.alloc(1024)])), { level: 9, mtime: 0 });
  const integrity = `sha512-${createHash("sha512").update(archive).digest("base64")}`;
  return { manifest, archive, integrity };
}

function fixtures() {
  return [
    packageFixture("esbuild", "0.25.11"),
    packageFixture("esbuild", "0.25.12"),
    packageFixture("esbuild-wasm", "0.25.12"),
    packageFixture("uses-esbuild", "1.0.0", { dependencies: { esbuild: "0.25.12" } }, "module.exports = require('esbuild');\n"),
    packageFixture("is-number", "7.0.0", {}, "module.exports = value => typeof value === 'number' && Number.isFinite(value);\n"),
    packageFixture("is-odd", "3.0.1", { dependencies: { "is-number": "^7.0.0" } }, "const isNumber = require('is-number'); module.exports = value => isNumber(value) && Math.abs(value % 2) === 1;\n"),
    packageFixture("@fixture/scoped", "1.0.0"),
    packageFixture("versioned", "1.0.0"),
    packageFixture("versioned", "1.1.0"),
    packageFixture("versioned", "2.0.0"),
    packageFixture("uses-one", "1.0.0", { dependencies: { versioned: "^1.0.0" } }, "module.exports = require('versioned');\n"),
    packageFixture("uses-two", "1.0.0", { dependencies: { versioned: "^2.0.0" } }, "module.exports = require('versioned');\n"),
    packageFixture("uses-latest", "1.0.0", { dependencies: { versioned: "latest" } }, "module.exports = require('versioned');\n"),
    packageFixture("rehoist-child", "1.0.0"),
    packageFixture("rehoist-child", "2.0.0"),
    packageFixture("rehoist-parent", "1.0.0"),
    packageFixture("rehoist-parent", "2.0.0", { dependencies: { "rehoist-child": "latest" } }, "module.exports = require('rehoist-child');\n"),
    packageFixture("uses-rehoist-parent", "1.0.0", { dependencies: { "rehoist-parent": "2.0.0" } }, "module.exports = require('rehoist-parent');\n"),
    packageFixture("peer-user", "1.0.0", { peerDependencies: { "is-number": "^7.0.0" } }, "module.exports = require('is-number')(3);\n"),
    packageFixture("optional-peer-user", "1.0.0", { peerDependencies: { versioned: "^1.0.0" }, peerDependenciesMeta: { versioned: { optional: true } } }),
    packageFixture("optional-user", "1.0.0", { optionalDependencies: { "missing-optional": "^1.0.0" } }),
    packageFixture("lifecycle", "1.0.0", { scripts: { postinstall: "bun -e \"require('fs').writeFileSync('POSTINSTALL-RAN', 'bad')\"" } }),
    packageFixture("bad-integrity", "1.0.0"),
    packageFixture("z-required-integrity", "1.0.0", { dependencies: { "bad-integrity": "1.0.0" } }),
    packageFixture("cycle-a", "1.0.0", { dependencies: { "cycle-b": "latest" } }, "module.exports = { name: 'cycle-a' }; module.exports.other = require('cycle-b').name;\n"),
    packageFixture("cycle-b", "1.0.0", { dependencies: { "cycle-a": "latest" } }, "module.exports = { name: 'cycle-b' }; module.exports.other = require('cycle-a').name;\n"),
    packageFixture("path-escape", "1.0.0", {}, undefined, [tarEntry("package/../../ESCAPED", "bad")]),
    packageFixture("link-escape", "1.0.0", {}, undefined, [tarEntry("package/escape", "", "2", "../../../ESCAPED")]),
  ];
}

/** Local npm metadata and tarballs. Every route is local; unknown packages return 404. */
export async function createRegistry(additionalPackages = []) {
  const packages = fixtures().concat(additionalPackages);
  const requests = [];
  const latest = new Map([["versioned", "1.0.0"]]);
  const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*", "access-control-expose-headers": "*", "cross-origin-resource-policy": "cross-origin" };
  let offline = false;
  let base;
  const server = createServer((req, res) => {
    if (req.url.startsWith("/stall/")) { requests.push({ path: req.url, accept: req.headers.accept }); return; }
    res.writeHead(req.method === "OPTIONS" ? 204 : statusFor(req.url), cors);
    if (req.method === "OPTIONS") return res.end();
    requests.push({ path: req.url, accept: req.headers.accept });
    if (offline) return res.end("registry deliberately offline");
    const archive = packages.find(item => tarballPath(item) === req.url);
    if (archive) return res.end(archive.archive);
    const name = decodeURIComponent(new URL(req.url, "http://registry.invalid").pathname.slice(1));
    const available = packages.filter(item => item.manifest.name === name);
    if (!available.length) return res.end(JSON.stringify({ error: "package not found", name }));
    res.end(JSON.stringify(packument(name, available)));
  });

  function tarballPath(item) {
    return `/tarballs/${encodeURIComponent(item.manifest.name)}-${item.manifest.version}.tgz`;
  }

  function statusFor(path) {
    if (offline) return 503;
    if (packages.some(item => tarballPath(item) === path)) return 200;
    const name = decodeURIComponent(new URL(path, "http://registry.invalid").pathname.slice(1));
    return packages.some(item => item.manifest.name === name) ? 200 : 404;
  }

  function packument(name, available) {
    const versions = Object.fromEntries(available.map(item => [item.manifest.version, {
      ...item.manifest,
      ...(item.manifest.scripts ? { hasInstallScript: true } : {}),
      dist: { tarball: `${base}${tarballPath(item)}`, integrity: name === "bad-integrity" ? `sha512-${Buffer.alloc(64).toString("base64")}` : item.integrity },
    }]));
    return { name, "dist-tags": { latest: latest.get(name) ?? available.at(-1).manifest.version }, versions };
  }

  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  return { base, requests, latest, setOffline(value) { offline = value; }, async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
