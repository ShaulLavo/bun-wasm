import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { needsRust } from "../../scripts/ci-changes.ts";
import { verifyGuestBuildReceipt } from "../../scripts/guest-build-receipt.ts";
import { guestBuilds } from "../../scripts/guest-source-manifest.ts";
import { receiptCli, withCliReceiptFixture } from "./guest-receipt-fixture.ts";

const workflow = await readFile(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
const producer = workflow.split("      - name: Build one host-engine guest for real-browser source cache acceptance\n")[1]?.split("      - uses: actions/upload-artifact@v4")[0];

test("CI keeps the source-cache feature tuple and uses the qualified receipt file contract", () => {
  expect(needsRust(["scripts/guest-source-manifest.ts"])).toBe(true);
  expect(guestBuilds["source-cache-browser"]).toEqual({ artifact: "bun-browser.wasm", package: "bunwasm-cli", features: ["engine-host", "bun-build"] });
  expect(guestBuilds.browser.features).toEqual(["engine-host", "bun-transpiler", "bun-build"]);
  expect(producer).toContain('guest_environment=$(bun scripts/guest-build-receipt.ts environment)\n          eval "$guest_environment"');
  expect(producer).toContain('inputs=$(mktemp "${TMPDIR}/bun-wasm-guest-inputs-XXXXXX")');
  expect(producer).toContain(`trap 'rm -f -- "$inputs"' EXIT`);
  expect(producer).toContain("trap 'exit 130' INT");
  expect(producer).toContain("trap 'exit 143' TERM");
  expect(producer).toContain('bun scripts/guest-build-receipt.ts inputs source-cache-browser > "$inputs"');
  expect(producer).toContain('"$GUEST_CARGO" build --release --locked -j 2 --target wasm32-wasip1 -p bunwasm-cli --no-default-features --features engine-host,bun-build');
  expect(producer).toContain('bun scripts/guest-build-receipt.ts write dist/source-cache-browser/bun-browser.wasm "$inputs"');
  expect(producer).toContain('cp "$CARGO_TARGET_DIR/wasm32-wasip1/release/bun.wasm" dist/source-cache-browser/bun-browser.wasm');
  expect(producer).toContain("git rev-parse HEAD HEAD^{tree} > dist/source-cache-browser/source.txt");
  expect(producer).toContain("sha256sum dist/source-cache-browser/bun-browser.wasm >> dist/source-cache-browser/source.txt");
});

test("source-cache CLI receipts bind synthetic artifact identity without claiming a final Wasm size", async () => {
  await withCliReceiptFixture(async fixture => {
    const started = receiptCli(fixture, "inputs", "source-cache-browser");
    expect(started.exitCode).toBe(0);
    expect(started.stderr.toString()).toBe("");
    const snapshot = join(fixture.root, "dist/source-cache-inputs.json");
    await writeFile(snapshot, started.stdout);
    const finished = receiptCli(fixture, "write", fixture.artifact, snapshot);
    expect(finished.exitCode).toBe(0);
    expect(finished.stderr.toString()).toBe("");
    const bytes = await readFile(fixture.artifact);
    const receipt = await Bun.file(`${fixture.artifact}.build.json`).json();
    verifyGuestBuildReceipt(bytes, receipt);
    expect(receipt.sourceManifest.build).toBe("source-cache-browser");
    expect(receipt.artifactBytes).toBe(bytes.byteLength);
    expect(() => verifyGuestBuildReceipt(bytes.subarray(1), receipt)).toThrow("does not match artifact bytes");
  });
});
