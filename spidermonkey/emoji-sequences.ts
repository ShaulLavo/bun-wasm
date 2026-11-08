// U2: emoji properties of strings for the irregexp ICU4X subset. ICU4X 2.4.0
// provides only Basic_Emoji; the other six come from Unicode emoji data files.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const emojiVersion = "18.0";
export const emojiInputs = [
  { name: "emoji-sequences.txt", url: "https://www.unicode.org/Public/18.0.0/emoji/emoji-sequences.txt", sha256: "1823dce71f3dd9cb0ad1976797baee4ffbdc1909756f43af8ce4c57f732843a4" },
  { name: "emoji-zwj-sequences.txt", url: "https://www.unicode.org/Public/18.0.0/emoji/emoji-zwj-sequences.txt", sha256: "f61b5213bdf85a57741a9f903cb38d0f39a3d13be6ff4aca3b39857e859a9191" },
] as const;
export const emojiOutput = "crates/bunwasm-spidermonkey/src/glue/emoji_sequences.rs";
export const emojiReceipt = "crates/bunwasm-spidermonkey/src/glue/emoji_sequences.inputs.json";
export const emojiGenerator = ["spidermonkey/emoji-sequences.ts", "spidermonkey/generate-emoji-sequences.ts", "crates/bunwasm-spidermonkey/src/glue/emoji.rs"];
// U2 and U3 Final_Sigma are generated or patched source; nothing is listed.
export const unicodeGaps: string[] = [];

const sequenceProperties = ["Emoji_Keycap_Sequence", "RGI_Emoji_Modifier_Sequence", "RGI_Emoji_Flag_Sequence", "RGI_Emoji_Tag_Sequence", "RGI_Emoji_ZWJ_Sequence"] as const;
type SequenceProperty = (typeof sequenceProperties)[number];
type Sequence = readonly number[];
export type EmojiData = {
  sequences: Record<SequenceProperty, Sequence[]>;
  basicRanges: [number, number][];
  basicStrings: Sequence[];
};

const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const identity = (path: string) => {
  const bytes = readFileSync(path);
  return { path, sha256: hash(bytes), bytes: bytes.length };
};
const hex = (cp: number) => cp.toString(16);
function codePoint(text: string): number {
  assert.match(text, /^[0-9A-F]{4,6}$/, `code point ${text}`);
  const value = Number.parseInt(text, 16);
  assert(value <= 0x10ffff && (value < 0xd800 || value > 0xdfff), `scalar value ${text}`);
  return value;
}
function dataLines(text: string): [string, string][] {
  assert.match(text, new RegExp(`^# Version: ${emojiVersion.replace(".", "\\.")}$`, "m"), `emoji data version ${emojiVersion}`);
  return text.split("\n").flatMap((line) => {
    const data = line.split("#", 1)[0]?.trim() ?? "";
    if (!data) return [];
    const [points = "", type = ""] = data.split(";").map((field) => field.trim());
    return [[points, type]];
  });
}
function addBasic(data: EmojiData, points: string) {
  const range = points.split("..");
  if (range.length === 2) {
    data.basicRanges.push([codePoint(range[0] ?? ""), codePoint(range[1] ?? "")]);
    return;
  }
  const sequence = points.split(" ").map(codePoint);
  if (sequence.length === 1) data.basicRanges.push([sequence[0] ?? 0, sequence[0] ?? 0]);
  else data.basicStrings.push(sequence);
}
function isSequenceProperty(type: string): type is SequenceProperty {
  return sequenceProperties.some((name) => name === type);
}
export function parseEmojiData(sequencesText: string, zwjText: string): EmojiData {
  const data: EmojiData = { sequences: { Emoji_Keycap_Sequence: [], RGI_Emoji_Modifier_Sequence: [], RGI_Emoji_Flag_Sequence: [], RGI_Emoji_Tag_Sequence: [], RGI_Emoji_ZWJ_Sequence: [] }, basicRanges: [], basicStrings: [] };
  const zwjLines = dataLines(zwjText);
  assert(zwjLines.every(([, type]) => type === "RGI_Emoji_ZWJ_Sequence"), "ZWJ file holds only ZWJ sequences");
  for (const [points, type] of dataLines(sequencesText).concat(zwjLines)) {
    if (type === "Basic_Emoji") {
      addBasic(data, points);
      continue;
    }
    assert(isSequenceProperty(type), `unknown emoji type ${type}`);
    assert(!points.includes(".."), `${type} has no ranges`);
    const sequence = points.split(" ").map(codePoint);
    assert(sequence.length >= 2, `${type} entries are strings`);
    data.sequences[type].push(sequence);
  }
  return data;
}

function compare(left: Sequence, right: Sequence): number {
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference) return difference;
  }
  return left.length - right.length;
}
// Order-independent FNV-1a 64 over sorted sequences; emoji.rs repeats it.
export function checksum(sequences: readonly Sequence[]): string {
  const mask = (1n << 64n) - 1n;
  const step = (state: bigint, value: number) => ((state ^ BigInt(value)) * 0x100000001b3n) & mask;
  let state = 0xcbf29ce484222325n;
  for (const sequence of sequences.toSorted(compare)) {
    for (const cp of sequence) state = step(state, cp);
    state = step(state, 0xffffffff);
  }
  return state.toString(16).padStart(16, "0");
}
const utf16Length = (sequence: Sequence) => sequence.reduce((length, cp) => length + (cp > 0xffff ? 2 : 1), 0);

function keycapBases(sequences: readonly Sequence[]): string {
  return sequences.map((sequence) => {
    const [base = 0, selector, keycap, ...rest] = sequence;
    assert(selector === 0xfe0f && keycap === 0x20e3 && rest.length === 0 && /^[#*0-9]$/.test(String.fromCharCode(base)), "keycap shape");
    return String.fromCharCode(base);
  }).join("");
}
function flagRegions(sequences: readonly Sequence[]): string {
  return sequences.map((sequence) => {
    assert.equal(sequence.length, 2, "flag is a Regional Indicator pair");
    return sequence.map((cp) => {
      assert(cp >= 0x1f1e6 && cp <= 0x1f1ff, "Regional Indicator");
      return String.fromCharCode(0x41 + cp - 0x1f1e6);
    }).join("");
  }).join("");
}
function modifierBases(sequences: readonly Sequence[]): number[] {
  const bases = new Map<number, number[]>();
  for (const [base = 0, modifier = 0, ...rest] of sequences) {
    assert(rest.length === 0 && modifier >= 0x1f3fb && modifier <= 0x1f3ff, "base plus one Fitzpatrick modifier");
    bases.set(base, (bases.get(base) ?? []).concat([modifier]));
  }
  for (const [base, modifiers] of bases) assert.deepEqual(modifiers, [0x1f3fb, 0x1f3fc, 0x1f3fd, 0x1f3fe, 0x1f3ff], `U+${hex(base)} takes all five modifiers in order`);
  return Array.from(bases.keys());
}
function checkTags(sequences: readonly Sequence[]) {
  for (const sequence of sequences) assert(sequence[0] === 0x1f3f4 && sequence.at(-1) === 0xe007f && sequence.slice(1, -1).every((cp) => cp >= 0xe0020 && cp <= 0xe007e), "tag sequence shape");
}
function checkZwj(sequences: readonly Sequence[]) {
  for (const sequence of sequences) assert(sequence.includes(0x200d), "ZWJ sequence contains U+200D");
}
function checkDistinct(data: EmojiData) {
  const all = Object.values(data.sequences).flat().concat(data.basicStrings).map((sequence) => sequence.join(" "));
  assert.equal(new Set(all).size, all.length, "RGI_Emoji components are distinct strings");
}

const escape = (sequence: Sequence) => sequence.map((cp) => `\\u{${hex(cp)}}`).join("");
function lines(sequences: readonly Sequence[]): string {
  return `"\\\n${sequences.map((sequence) => escape(sequence) + "\n").join("")}"`;
}
function wrap(items: readonly string[], indent: string): string {
  const rows: string[] = [];
  for (let i = 0; i < items.length; i += 8) rows.push(indent + items.slice(i, i + 8).join(", ") + ",");
  return rows.join("\n");
}
export function renderEmojiData(data: EmojiData): string {
  const { sequences } = data;
  checkTags(sequences.RGI_Emoji_Tag_Sequence);
  checkZwj(sequences.RGI_Emoji_ZWJ_Sequence);
  checkDistinct(data);
  const all = Object.values(sequences).flat().concat(data.basicStrings);
  const maxUnits = Math.max(...all.map(utf16Length));
  const counts = sequenceProperties.map((name) => `    (${sequences[name].length}, 0x${checksum(sequences[name])}),`);
  const modifiers = modifierBases(sequences.RGI_Emoji_Modifier_Sequence).map((cp) => `'\\u{${hex(cp)}}'`);
  const ranges = data.basicRanges.map(([first, last]) => `(0x${hex(first)}, 0x${hex(last)})`);
  const strings = data.basicStrings.map((sequence) => `&[${sequence.map((cp) => `0x${hex(cp)}`).join(", ")}]`);
  return `// @generated by spidermonkey/generate-emoji-sequences.ts from Unicode emoji ${emojiVersion}.
// Do not edit. Inputs and hashes: emoji_sequences.inputs.json.

/// Longest UTF-16 string among all emoji properties of strings.
pub(super) const MAX_UTF16_UNITS: usize = ${maxUnits};
/// Keycap sequences are each base, U+FE0F, U+20E3.
pub(super) const KEYCAP_BASES: &[u8] = b"${keycapBases(sequences.Emoji_Keycap_Sequence)}";
/// Each base takes U+1F3FB..=U+1F3FF.
#[rustfmt::skip]
pub(super) const MODIFIER_BASES: &[char] = &[
${wrap(modifiers, "    ")}
];
/// Letter pairs; A..=Z map to U+1F1E6..=U+1F1FF.
pub(super) const FLAG_REGIONS: &[u8] = b"${flagRegions(sequences.RGI_Emoji_Flag_Sequence)}";
/// One sequence per line.
pub(super) const TAG_SEQUENCES: &str = ${lines(sequences.RGI_Emoji_Tag_Sequence)};
/// One sequence per line.
pub(super) const ZWJ_SEQUENCES: &str = ${lines(sequences.RGI_Emoji_ZWJ_Sequence)};

/// Count and order-independent FNV-1a 64 of each input list, in property order 66..=70.
#[cfg(all(test, feature = "unicode-controls"))]
#[rustfmt::skip]
pub(crate) const EXPECTED: [(usize, u64); 5] = [
${counts.join("\n")}
];
/// The input file's Basic_Emoji code points, compared with ICU4X 2.4.0 data.
#[cfg(all(test, feature = "unicode-controls"))]
#[rustfmt::skip]
pub(crate) const BASIC_EMOJI_RANGES: &[(u32, u32)] = &[
${wrap(ranges, "    ")}
];
/// The input file's Basic_Emoji strings, compared with ICU4X 2.4.0 data.
#[cfg(all(test, feature = "unicode-controls"))]
#[rustfmt::skip]
pub(crate) const BASIC_EMOJI_STRINGS: &[&[u32]] = &[
${wrap(strings, "    ")}
];
`;
}

export function readInputs(directory: string): [string, string] {
  const texts = emojiInputs.map((input) => {
    const path = join(directory, input.name);
    const bytes = readFileSync(path);
    assert.equal(hash(bytes), input.sha256, `${path} must be ${input.url}`);
    return bytes.toString("utf8");
  });
  return [texts[0] ?? "", texts[1] ?? ""];
}
export function emojiCustody(data: EmojiData, output: string) {
  return {
    profile: { intlApi: false, irregexpUnicode: "icu4x-subset", stringProperties: "generated-unicode-emoji" },
    unicodeVersion: "18.0.0", emojiVersion,
    inputs: emojiInputs,
    generator: emojiGenerator.map(identity),
    output: { path: emojiOutput, sha256: hash(output), bytes: Buffer.byteLength(output) },
    properties: Object.fromEntries(sequenceProperties.map((name) => [name, { count: data.sequences[name].length, checksum: checksum(data.sequences[name]) }])),
    basicEmoji: { source: "ICU4X 2.4.0 compiled data", inputRanges: data.basicRanges.length, inputStrings: data.basicStrings.length },
    unsupported: unicodeGaps,
  };
}
type Identity = { path: string; sha256: string };
type Custody = { inputs: unknown; generator: Identity[]; output: Identity; unsupported: unknown };
function isCustody(value: unknown): value is Custody {
  if (!value || typeof value !== "object" || !("inputs" in value) || !("generator" in value) || !("output" in value) || !("unsupported" in value)) return false;
  return Array.isArray(value.generator) && !!value.output && typeof value.output === "object";
}
// Checks recorded bytes without the Unicode inputs. Regeneration replays them.
export function checkEmojiCustody(root = ".") {
  const raw: unknown = JSON.parse(readFileSync(join(root, emojiReceipt), "utf8"));
  assert(isCustody(raw), "emoji custody shape");
  const entries = raw.generator.concat([raw.output]);
  assert.deepEqual(raw.generator.map((entry) => entry.path), emojiGenerator, "emoji generator inputs");
  assert.deepEqual(raw.inputs, emojiInputs, "pinned Unicode emoji inputs");
  assert.deepEqual(raw.unsupported, unicodeGaps, "recorded Unicode gaps");
  for (const entry of entries) assert.equal(hash(readFileSync(join(root, entry.path))), entry.sha256, `stale emoji custody: ${entry.path}`);
  assert.equal(raw.output.path, emojiOutput);
  return raw;
}
