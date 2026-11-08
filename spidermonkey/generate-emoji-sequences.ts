// Usage: generate-emoji-sequences.ts --inputs DIR [--check]
// DIR holds the two pinned Unicode emoji files from emojiInputs. Without
// --inputs, --check verifies only the recorded generator and output hashes.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { checkEmojiCustody, emojiCustody, emojiInputs, emojiOutput, emojiReceipt, parseEmojiData, readInputs, renderEmojiData } from "./emoji-sequences.ts";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}
function main() {
  const check = process.argv.includes("--check");
  const inputs = option("--inputs");
  if (!inputs) {
    assert(check, `--inputs DIR is required; fetch ${emojiInputs.map((input) => input.url).join(" and ")}`);
    checkEmojiCustody();
    process.stdout.write(JSON.stringify({ check, custody: "recorded hashes match", inputsReplayed: false }) + "\n");
    return;
  }
  const data = parseEmojiData(...readInputs(inputs));
  const output = renderEmojiData(data);
  const receipt = emojiCustody(data, output);
  const receiptBytes = JSON.stringify(receipt, null, 2) + "\n";
  if (check) {
    assert.equal(readFileSync(emojiOutput, "utf8"), output, "generated emoji tables are stale");
    assert.equal(readFileSync(emojiReceipt, "utf8"), receiptBytes, "emoji generator/data custody is stale");
  } else {
    writeFileSync(emojiOutput, output);
    writeFileSync(emojiReceipt, receiptBytes);
  }
  process.stdout.write(JSON.stringify({ check, inputsReplayed: true, output: receipt.output, properties: receipt.properties }) + "\n");
}
main();
