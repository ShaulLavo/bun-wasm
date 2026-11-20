// Writes two modules QuickJS's time zones read (docs/bun-patches/quickjs-time-zones.md), from
// native Bun's ICU and the runtime's FormatJS zone data (tz_data.js). Run with native Bun:
//   bun scripts/generate-zone-names.ts
//
// zone_ids.js: the zone Bun reports after `process.env.TZ = name`, for every name in the data
// whose zone differs from FormatJS's link (FormatJS merges Asia/Kuala_Lumpur into Singapore and
// has no Africa/Abidjan for Africa/Dakar's group).
//
// zone_names.js: the names native Bun prints in Date.prototype.toString for every such zone, keyed
// by FormatJS's offset (minutes east of UTC, whole minutes as QuickJS keeps them) and daylight
// flag, sampled monthly from 1970 to 2037. A key lists each name with the day (since 1970, base
// 36) it starts on, so a zone keeps the names of past eras: "minutes:dst:name:day,...". A name ICU
// prints as the bare offset ("GMT-03:00") is stored as "" and built at run time
// (bootstrap.js gmtName).
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import vm from "node:vm";

const js = join(resolve(import.meta.dir, ".."), "crates/bunwasm-runtime/src/js");
const data = vm.runInNewContext(readFileSync(join(js, "tz_data.js"), "utf8"))();
const offsets: number[] = data.offsets.split("|").map((offset: string) => parseInt(offset, 36));
const links: Record<string, string> = data.links;
const zones = new Map<string, [time: number, offset: number, dst: boolean][]>();
for (const zone of data.zones as string[]) {
  const [name, ...entries] = zone.split("|");
  const parsed = entries.flatMap(entry => {
    const [time, , offsetIndex, dst] = entry.split(",");
    if (time === "NaN") return [];
    return [[time === "" ? -Infinity : parseInt(time!, 36), offsets[Number(offsetIndex)]!, dst === "1"] as [number, number, boolean]];
  });
  zones.set(name!, parsed);
}

// The zone Bun reports after a TZ write, or null when Bun keeps the previous zone (unknown).
const sentinel = "Pacific/Kiritimati";
function bunZone(name: string): string | null {
  process.env.TZ = sentinel;
  process.env.TZ = name;
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return zone === sentinel && name !== sentinel ? null : zone;
}

// The zone whose entries time_zone.rs and time_zone.ts use for a name: its own, else FormatJS's
// link; "" for none (Africa/Abidjan's group, GMT all along).
function dataZone(name: string): string {
  if (zones.has(name)) return name;
  return zones.has(links[name] ?? "") ? links[name]! : "";
}

// ids lists a name only where time_zone.ts would not find Bun's zone itself: a name with
// entries of its own is its own zone, and so is a link's target unless listed.
const ids: Record<string, string> = {};
const bunZones = new Map<string, string>();
for (const name of new Set(Array.from(zones.keys()).concat(Object.keys(links), ["Africa/Abidjan"]))) {
  const id = bunZone(name);
  if (id === null) continue;
  const target = zones.has(name) ? name : links[name] ?? name;
  const formatjs = target === "Etc/UTC" || target === "Etc/GMT" ? "UTC" : target;
  if (id !== formatjs) ids[name] = id;
  if (id !== "UTC") bunZones.set(id, dataZone(id));
}
delete process.env.TZ;

// FormatJS's offset in whole minutes and daylight flag at a UTC instant; a zone without entries
// (Africa/Abidjan's group) is GMT all along.
function state(target: string, ms: number): [minutes: number, dst: boolean] {
  let current: [number, number, boolean] = [-Infinity, 0, false];
  for (const entry of zones.get(target) ?? []) {
    if (entry[0] > ms / 1000) break;
    current = entry;
  }
  return [Math.trunc(current[1] / 60), current[2]];
}

// The name the runtime builds for an offset with no name; keep in step with bootstrap.js gmtName.
function gmtName(minutes: number): string {
  if (minutes === 0) return "GMT";
  const abs = Math.abs(minutes);
  return `GMT${minutes < 0 ? "-" : "+"}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

// The name native Bun's toString prints at an instant in the zone TZ names (JavaScriptCore asks
// ICU for the zone's standard or daylight name, which is not always Intl's long name for that
// date), or "" for the bare offset the runtime builds itself.
function bunName(ms: number, minutes: number): string {
  const text = new Date(ms).toString();
  const name = text.slice(text.lastIndexOf("(") + 1, -1);
  return name === gmtName(minutes) ? "" : name;
}

const names = [""];
const indexes = new Map([["", 0]]);
const entries: Record<string, string> = {};
for (const [id, target] of Array.from(bunZones).toSorted(([a], [b]) => a.localeCompare(b))) {
  process.env.TZ = id;
  const current = new Map<string, number>();
  const list: string[] = [];
  for (let month = 0; month < 68 * 12; month++) {
    const ms = Date.UTC(1970, month, 15, 12);
    const [minutes, dst] = state(target, ms);
    const name = bunName(ms, minutes);
    if (!indexes.has(name)) indexes.set(name, names.push(name) - 1);
    const key = `${minutes}:${dst ? 1 : 0}`;
    const index = indexes.get(name)!;
    if (current.get(key) === index) continue;
    // A key's first name applies from the beginning (day 0 stands for all earlier days too); a
    // later one from the first day since the previous sample that Bun names so.
    let day = Math.floor(ms / 86400000);
    while (current.has(key) && day > Math.floor(ms / 86400000) - 31 && bunName((day - 1) * 86400000 + 43200000, minutes) === name) day--;
    list.push(`${key}:${index}:${current.has(key) ? day.toString(36) : 0}`);
    current.set(key, index);
  }
  entries[id] = list.join(",");
}
delete process.env.TZ;

const banner = `// Generated by scripts/generate-zone-names.ts with Bun ${Bun.version} (ICU ${process.versions.icu}).\n`;
writeFileSync(join(js, "zone_names.js"), `${banner}(function () { return ${JSON.stringify({ names, zones: entries })}; })\n`);
writeFileSync(join(js, "zone_ids.js"), `${banner}(function () { return ${JSON.stringify(ids)}; })\n`);
console.log(`${bunZones.size} zones, ${names.length} names; ${Object.keys(ids).length} names whose zone differs from FormatJS's`);
