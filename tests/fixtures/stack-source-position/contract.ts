import assert from "node:assert/strict";

export function newTokenLength(text: string, column: number): number {
  return /^new\s+/.exec(text.slice(column - 1))?.[0].length ?? 0;
}

export function stackCases() {
  const whitespace = ["\t", "\v", "\f", " ", "\u00a0", "\u1680", "\u2000", "\u2001", "\u2002", "\u2003", "\u2004", "\u2005", "\u2006", "\u2007", "\u2008", "\u2009", "\u200a", "\u2028", "\u2029", "\u202f", "\u205f", "\u3000", "\ufeff"];
  const separators = whitespace.concat(["\u0085", "\u180e", "\u200b", "\u2060", "", "x"]);
  return separators.flatMap(space => ["", "/*😀*/", "/*𐐀😀*/"].map(prefix => ({ text: `${prefix}new${space}Error('stack')`, column: prefix.length + 1 })));
}

export function tokenCases() {
  return stackCases().concat([
    { text: "new Error()", column: NaN }, { text: "new Error()", column: Infinity },
    { text: "new Error()", column: -Infinity }, { text: "xxxnew Error()", column: -10 },
    { text: "new Error()", column: -0.5 }, { text: "new Error()", column: 1.9 },
    { text: "\ufeffnew Error()", column: 1 }, { text: "\ufeffnew Error()", column: 2 },
    { text: "new Error()", column: 0 }, { text: "new Error()", column: 99 },
    { text: "😀new\t Error()", column: 2 }, { text: "😀new\t Error()", column: 3 },
    { text: "", column: 1 }, { text: "new", column: 1 }, { text: "renew Error()", column: 1 },
  ]);
}

export function verifyTokenLengths(offset: (text: string, column: number) => number) {
  for (const item of tokenCases()) assert.equal(offset(item.text, item.column), newTokenLength(item.text, item.column), JSON.stringify(item));
}

export function verifyStackSources(load: (source: string, name: string) => { line: number; column: number }) {
  const cases = [
    { prefix: "", space: " ", padding: "" },
    { prefix: "/*😀𐐀*/", space: "\t\ufeff\u00a0", padding: "" },
    { prefix: "/*😀*/", space: " ", padding: "x".repeat(1024 * 1024) },
  ];
  for (const [index, item] of cases.entries()) {
    const source = `${item.prefix}module.exports = new${item.space}Error('stack');/*${item.padding}*/`;
    const column = source.indexOf("new") + 1;
    assert.deepEqual(load(source, `line-${index}.cjs`), { line: 1, column: column + newTokenLength(source, column) });
  }
}

export function verifyMappedStackSource(load: (source: string, name: string) => { line: number; column: number }) {
  const source = "interface Removed { value: number }\nconst typed: number = 1; /*😀*/module.exports = new\t\ufeff Error('mapped');";
  const line = source.split("\n")[1];
  assert.ok(line);
  const column = line.indexOf("new") + 1;
  assert.deepEqual(load(source, "mapped.cts"), { line: 2, column: column + newTokenLength(line, column) });
}

export function verifyRawStackSources(load: (source: string, name: string) => { raw: readonly { line: number; column: number }[]; formatted: { line: number; column: number } }) {
  const prefix = "/*😀中é*/";
  const cases = [
    { body: "module.exports = new\t\ufeff\u00a0Error('raw');", markers: ["Error('raw')"] },
    { body: "module.exports = Error('raw');", markers: ["Error('raw')"] },
    { body: "\r\n/*é😀*/module.exports = new\tError('raw');", markers: ["Error('raw')"] },
    { body: "function fail() { return Error('raw'); } module.exports = fail();", markers: ["Error('raw')", "fail();"] },
    { body: "const owner = { fail() { return Error('raw'); } }; module.exports = owner.fail();", markers: ["Error('raw')", "fail();"] },
  ];
  for (const [index, item] of cases.entries()) {
    const source = prefix + item.body;
    const result = load(source, `raw-${index}.cjs`);
    const expected = item.markers.map(marker => {
      const lines = source.slice(0, source.lastIndexOf(marker)).split("\n");
      return { line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 };
    });
    const normalized = result.raw.map(site => {
      const line = source.split("\n")[site.line - 1];
      assert.notEqual(line, undefined);
      return { line: site.line, column: site.column + newTokenLength(line ?? "", site.column) };
    });
    assert.deepEqual(normalized, expected, source);
    assert.deepEqual(result.formatted, expected[0], source);
  }
}
