import assert from "node:assert/strict";
import { spawn } from "node:child_process";

async function runChild(mode: "read" | "readv"): Promise<string> {
  const childScript = `
    import fs from "node:fs";
    import assert from "node:assert/strict";
    const ab = new ArrayBuffer(16);
    const view = new Uint8Array(ab);
    const mode = ${JSON.stringify(mode)};
    if (mode === "read") {
      fs.read(0, view, 0, 16, null, (err, bytesRead) => {
        assert.equal(err, null);
        assert.equal(bytesRead, 5);
        assert.equal(ab.detached, false);
        assert.equal(Buffer.from(view.subarray(0, 5)).toString("utf8"), "hello");
        // Pin must be released before user callback so transfer detaches now.
        const post = ab.transfer();
        assert.equal(ab.detached, true);
        assert.equal(post.byteLength, 16);
        process.stdout.write("read-ok");
      });
      const copy = ab.transfer();
      assert.equal(ab.detached, false);
      assert.equal(copy.byteLength, 16);
      process.stdout.write("READY\\n");
    } else {
      const v1 = new Uint8Array(ab, 0, 3);
      const v2 = new Uint8Array(ab, 3, 5);
      fs.readv(0, [v1, v2], (err, bytesRead) => {
        assert.equal(err, null);
        assert.equal(bytesRead, 5);
        assert.equal(ab.detached, false);
        assert.equal(Buffer.from(v1).toString("utf8") + Buffer.from(v2.subarray(0, 2)).toString("utf8"), "world");
        const post = ab.transfer();
        assert.equal(ab.detached, true);
        assert.equal(post.byteLength, 16);
        process.stdout.write("readv-ok");
      });
      const copy = ab.transfer();
      assert.equal(ab.detached, false);
      assert.equal(copy.byteLength, 16);
      process.stdout.write("READY\\n");
    }
  `;
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", childScript], {
      stdio: ["pipe", "pipe", "inherit"],
    });
    let out = "";
    let sent = false;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      out += chunk;
      if (!sent && out.includes("READY\n")) {
        sent = true;
        child.stdin.end(mode === "read" ? "hello" : "world");
      }
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`${mode} child exited with ${code}: ${out}`));
      else resolve(out);
    });
  });
}

assert.equal(await runChild("read"), "READY\nread-ok");
assert.equal(await runChild("readv"), "READY\nreadv-ok");
console.log("ok fs-async-stdin-pins");
