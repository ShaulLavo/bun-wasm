import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nextRegistry } from "../../web/tests/next-framework-registry";

const path = "/-/npm/v1/security/advisories/bulk";
const body = '{"next":["16.4.3"]}';
const sha256 = (bytes: string) => createHash("sha256").update(bytes).digest("hex");

test("composed registry replays only the exact advisory POST and preserves GET integrity", async () => {
  const directory = mkdtempSync(join(tmpdir(), "advisory-replay-"));
  let mirror: ReturnType<typeof nextRegistry> | undefined;
  try {
    const extra = join(directory, "extra");
    const overlay = join(directory, "overlay");
    for (const root of [extra, overlay]) mkdirSync(join(root, "objects"), { recursive: true });
    const advisory = '{"next":[{"id":123,"severity":"high","title":"Fixture advisory"}]}';
    const tarball = "checksum-verified tarball";
    writeFileSync(join(extra, "objects", sha256(tarball)), tarball);
    writeFileSync(join(extra, "index.json"), JSON.stringify({ "/pkg/-/pkg.tgz": { status: 200, type: "application/octet-stream", sha256: sha256(tarball) } }));
    writeFileSync(join(overlay, "objects", sha256(advisory)), advisory);
    writeFileSync(join(overlay, "index.json"), JSON.stringify({ [`POST ${path} ${sha256(body)}`]: { status: 200, type: "application/json", sha256: sha256(advisory) } }));
    mirror = nextRegistry(extra, 0, overlay);
    const post = (target: string, payload: string, method = "POST") => fetch(`${mirror!.base}${target}`, { method, body: payload, headers: { "content-type": "application/json" } });
    const response = await post(path, body);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(advisory);
    for (const [target, payload, method] of [[path, `${body} `, "POST"], [path, body, "PUT"], [`${path}/`, body, "POST"], [`${path}?x=1`, body, "POST"]]) {
      expect((await post(target!, payload!, method)).status).toBeGreaterThanOrEqual(400);
    }
    expect((await fetch(`${mirror.base}${path}`)).status).toBeGreaterThanOrEqual(400);
    expect(await (await fetch(`${mirror.base}/pkg/-/pkg.tgz`)).text()).toBe(tarball);
    expect((await post("/pkg/-/pkg.tgz", body)).status).toBeGreaterThanOrEqual(400);
    writeFileSync(join(extra, "objects", sha256(tarball)), "corrupt");
    expect((await fetch(`${mirror.base}/pkg/-/pkg.tgz`)).status).toBe(502);
    writeFileSync(join(overlay, "objects", sha256(advisory)), "corrupt");
    expect((await post(path, body)).status).toBe(502);
  } finally { await mirror?.close(); rmSync(directory, { recursive: true, force: true }); }
});
