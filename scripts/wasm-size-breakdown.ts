import { readFileSync } from "node:fs";

class Reader {
  at = 0;
  constructor(readonly bytes: Uint8Array) {}
  byte(): number { return this.bytes[this.at++]!; }
  uint(): number {
    let result = 0, shift = 0, value: number;
    do { value = this.byte(); result += (value & 127) * 2 ** shift; shift += 7; } while (value & 128);
    return result;
  }
  slice(size: number): Uint8Array { const start = this.at; this.at += size; return this.bytes.subarray(start, this.at); }
  string(): string { return new TextDecoder().decode(this.slice(this.uint())); }
  subsection(): Reader { return new Reader(this.slice(this.uint())); }
}

function readNames(section: Reader, names: Map<number, string>): void {
  while (section.at < section.bytes.length) {
    const kind = section.byte(), sub = section.subsection();
    if (kind !== 1) continue;
    const count = sub.uint();
    for (let i = 0; i < count; i++) names.set(sub.uint(), sub.string());
  }
}

function readBodies(section: Reader): number[] {
  const bodies: number[] = [];
  const count = section.uint();
  for (let i = 0; i < count; i++) { const size = section.uint(); bodies.push(size); section.slice(size); }
  return bodies;
}

function readData(section: Reader): { bytes: number; prefix: string }[] {
  const data: { bytes: number; prefix: string }[] = [];
  const count = section.uint();
  for (let i = 0; i < count; i++) {
    const flags = section.uint();
    if (flags === 2) section.uint();
    if (flags !== 1) {
      if (section.byte() !== 0x41) throw new Error("expected i32.const data offset");
      section.uint();
      if (section.byte() !== 0x0b) throw new Error("expected data offset end");
    }
    const bytes = section.slice(section.uint());
    data.push({ bytes: bytes.length, prefix: new TextDecoder().decode(bytes.subarray(0, 48)) });
  }
  return data;
}

const labels = ["custom", "types", "imports", "functions", "tables", "memories", "globals", "exports", "start", "elements", "code", "data", "data count"];
for (const path of process.argv.slice(2)) {
  const reader = new Reader(readFileSync(path));
  reader.at = 8;
  const sections: { section: string; bytes: number }[] = [];
  let bodies: number[] = [], dataSegments: ReturnType<typeof readData> = [];
  const names = new Map<number, string>();
  let defined = 0;
  while (reader.at < reader.bytes.length) {
    const id = reader.byte(), length = reader.uint();
    const section = new Reader(reader.slice(length));
    const name = id === 0 ? section.string() : labels[id] ?? String(id);
    sections.push({ section: name, bytes: length });
    if (id === 3) defined = section.uint();
    if (id === 10) bodies = readBodies(section);
    if (id === 11) dataSegments = readData(section);
    if (id === 0 && name === "name") readNames(section, names);
  }
  const imported = Math.max(...names.keys()) + 1 - defined;
  const functions = bodies.map((bytes, index) => ({ bytes, name: names.get(index + imported) ?? String(index + imported) }));
  const groups: Record<string, number> = {};
  for (const fn of functions) {
    const group = /JSC|WTF|bmalloc|Yarr/.test(fn.name) ? "WebKit" : /icu|^[uU][A-Za-z_]*_[0-9]+$/.test(fn.name) ? "ICU" : /bun_lint|bun_fmt|bun_sema|bun_syntax/.test(fn.name) ? "Bun lint/sema" : "other";
    groups[group] = (groups[group] ?? 0) + fn.bytes;
  }
  functions.sort((a, b) => b.bytes - a.bytes);
  dataSegments.sort((a, b) => b.bytes - a.bytes);
  console.log(JSON.stringify({ path, bytes: reader.bytes.length, sections, codeGroups: groups, largestFunctions: functions.slice(0, 30), largestData: dataSegments.slice(0, 20) }, null, 2));
}
