import { expect, test } from "bun:test";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { requireProbeEvidence, inspectProbe, qualifyProbe } from "./tls-probe.ts";

test("TLS G0 runs verified handshakes and live failure controls", async () => {
  const output = process.env.BUNWASM_TLS_PROBE_OUTPUT;
  const binary = await requireProbeEvidence(output);
  if (!output) throw new Error("Missing output");
  const imports = await inspectProbe(binary);
  const result = await qualifyProbe(binary, output);
  expect(result.results.map(item => item.name)).toEqual(["tls12-valid", "tls13-valid", "unknown-ca-rejected", "expired-peer-rejected", "hostname-rejected"]);
  writeFileSync(join(output, "result.json"), JSON.stringify({ imports, ...result }, null, 2) + "\n");
}, 180_000);
