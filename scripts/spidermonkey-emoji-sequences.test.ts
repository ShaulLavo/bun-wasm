import { expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkEmojiCustody, checksum, emojiGenerator, emojiOutput, emojiReceipt, parseEmojiData, renderEmojiData } from "../spidermonkey/emoji-sequences.ts";

const modifiers = ["1F3FB", "1F3FC", "1F3FD", "1F3FE", "1F3FF"];
function sequencesText(extra: string[] = [], omitModifier = "") {
  return ["# Version: 18.0", "0023 FE0F 20E3 ; Emoji_Keycap_Sequence ; keycap: # # E0.6",
    "1F1EE 1F1F1 ; RGI_Emoji_Flag_Sequence ; flag: Israel",
    "1F3F4 E0067 E0062 E0065 E006E E0067 E007F ; RGI_Emoji_Tag_Sequence ; flag: England",
    "231A..231B ; Basic_Emoji ; watch..hourglass", "2764 FE0F ; Basic_Emoji ; red heart"]
    .concat(modifiers.filter((modifier) => modifier !== omitModifier).map((modifier) => `261D ${modifier} ; RGI_Emoji_Modifier_Sequence ; index`), extra).join("\n");
}
const zwjText = "# Version: 18.0\n1F468 200D 1F469 ; RGI_Emoji_ZWJ_Sequence ; couple # E2.0\n";

test("the committed U2 tables match their recorded generator and output hashes", () => {
  const custody = checkEmojiCustody();
  expect(custody.output.path).toBe(emojiOutput);
  expect(custody.unsupported).toEqual([]);
});

test("rendering compacts each property and records input checksums", () => {
  const data = parseEmojiData(sequencesText(), zwjText);
  expect(data.basicRanges).toEqual([[0x231a, 0x231b]]);
  expect(data.basicStrings).toEqual([[0x2764, 0xfe0f]]);
  const output = renderEmojiData(data);
  expect(output).toContain('KEYCAP_BASES: &[u8] = b"#";');
  expect(output).toContain('FLAG_REGIONS: &[u8] = b"IL";');
  expect(output).toContain("'\\u{261d}',");
  expect(output).toContain("\\u{1f468}\\u{200d}\\u{1f469}\n");
  expect(output).toContain("MAX_UTF16_UNITS: usize = 14;");
  expect(output).toContain(`(1, 0x${checksum([[0x23, 0xfe0f, 0x20e3]])}),`);
});

test("checksums ignore order but not content", () => {
  expect(checksum([[1, 2], [3]])).toBe(checksum([[3], [1, 2]]));
  expect(checksum([[1, 2], [3]])).not.toBe(checksum([[1], [2, 3]]));
});

test("malformed or changed Unicode data is rejected instead of rendered", () => {
  expect(() => parseEmojiData(sequencesText().replace("18.0", "17.0"), zwjText)).toThrow(/emoji data version/);
  expect(() => parseEmojiData(sequencesText(["1F1EE..1F1F1 ; RGI_Emoji_Flag_Sequence ; range"]), zwjText)).toThrow(/no ranges/);
  expect(() => parseEmojiData(sequencesText(["1F600 1F601 ; RGI_Emoji_New_Sequence ; new"]), zwjText)).toThrow(/unknown emoji type/);
  expect(() => parseEmojiData(sequencesText(), zwjText + "0023 FE0F 20E3 ; Emoji_Keycap_Sequence ; keycap\n")).toThrow(/only ZWJ/);
  expect(() => renderEmojiData(parseEmojiData(sequencesText([], "1F3FD"), zwjText))).toThrow(/all five modifiers/);
  expect(() => renderEmojiData(parseEmojiData(sequencesText(["1F1EE 0041 ; RGI_Emoji_Flag_Sequence ; bad"]), zwjText))).toThrow(/Regional Indicator/);
  expect(() => renderEmojiData(parseEmojiData(sequencesText(), "# Version: 18.0\n1F468 1F469 ; RGI_Emoji_ZWJ_Sequence ; no joiner\n"))).toThrow(/U\+200D/);
  expect(() => renderEmojiData(parseEmojiData(sequencesText(["2764 FE0F ; RGI_Emoji_Tag_Sequence ; reused"]), zwjText))).toThrow();
  expect(() => renderEmojiData(parseEmojiData(sequencesText(["0023 FE0F 20E3 ; Emoji_Keycap_Sequence ; duplicate"]), zwjText))).toThrow(/distinct/);
});

test("custody rejects stale generated output", () => {
  const root = mkdtempSync(join(tmpdir(), "bun-wasm-emoji-custody-"));
  try {
    for (const path of emojiGenerator.concat([emojiOutput, emojiReceipt])) {
      mkdirSync(join(root, dirname(path)), { recursive: true });
      cpSync(path, join(root, path));
    }
    expect(() => checkEmojiCustody(root)).not.toThrow();
    writeFileSync(join(root, emojiOutput), "// edited\n");
    expect(() => checkEmojiCustody(root)).toThrow(/stale emoji custody/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
