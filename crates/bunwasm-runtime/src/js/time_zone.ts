// process.env.TZ for QuickJS, whose local time comes from wasi-libc and is always UTC. The zone
// is resolved and its UTC offsets read from the zone data the fallback Intl already ships
// (tz_data.js, FormatJS's add-all-tz), and the engine applies them to Date
// (JS_bunwasm_SetLocalTimeOffsets in quickjs.c). Names resolve as ICU resolves them for
// JavaScriptCore: links to their zone, GMT and Etc/UTC to UTC.
(function (internal: BunWasm.Internal) {
  "use strict";
  type ZoneData = { abbrvs: string; offsets: string; zones: string[]; links: Record<string, string> };
  type Zones = { names: Map<string, string>; entries: Map<string, string>; links: Map<string, string>; offsets: number[] };

  // tzdata 2024b made these POSIX-style zones links to their cities, and ICU resolves them so.
  // FormatJS's data predates that and has no entry for them.
  const cityLinks = new Map([
    ["EST5EDT", "America/New_York"], ["CST6CDT", "America/Chicago"],
    ["MST7MDT", "America/Denver"], ["PST8PDT", "America/Los_Angeles"],
  ]);
  let zones: Zones | undefined;

  function load(): Zones {
    if (zones) return zones;
    const data: ZoneData = internal.require("tz_data");
    const names = new Map<string, string>();
    const entries = new Map<string, string>();
    for (const zone of data.zones) {
      const separator = zone.indexOf("|");
      const name = zone.slice(0, separator);
      names.set(name.toUpperCase(), name);
      entries.set(name, zone.slice(separator + 1));
    }
    const links = new Map(Object.entries(data.links).map(([from, to]) => [from.toUpperCase(), to]));
    zones = { names, entries, links, offsets: data.offsets.split("|").map(offset => parseInt(offset, 36)) };
    return zones;
  }

  // FormatJS's CanonicalizeTimeZoneName, with the city links above.
  function resolve(name: string, data: Zones): string | undefined {
    const upper = name.toUpperCase();
    const resolved = cityLinks.get(upper) ?? data.links.get(upper) ?? data.names.get(upper);
    return resolved === "Etc/UTC" || resolved === "Etc/GMT" ? "UTC" : resolved;
  }

  // A zone's offsets as `[offset, time, offset, ...]` (seconds): the first offset applies from
  // the beginning, each later one from its time on. FormatJS lists `time,abbreviation,offset,dst`
  // entries in order; the first has no time, and a final "NaN" entry keeps the last offset.
  function offsetsOf(entries: string, data: Zones): number[] {
    const table: number[] = [];
    for (const entry of entries.split("|")) {
      const [time, , offsetIndex] = entry.split(",");
      const offset = data.offsets[Number(offsetIndex)]!;
      if (table.length === 0) {
        table.push(offset);
        continue;
      }
      if (time === "NaN" || offset === table[table.length - 1]) continue;
      table.push(parseInt(time!, 36), offset);
    }
    return table;
  }

  // The zone ID now in use, or null when `zone` names no zone (the previous zone stays). An
  // empty name restores the start zone, UTC.
  // The names that are UTC, answered without loading the 1.36 MB zone data: test harnesses and
  // CI often start every process with one of them.
  const utcNames = new Set(["", "UTC", "ETC/UTC", "GMT", "ETC/GMT"]);
  return function applyTimeZone(zone: string): string | null {
    const native = internal.native;
    if (utcNames.has(zone.toUpperCase())) {
      native.setLocalTimeOffsets?.(null);
      return "UTC";
    }
    const data = load();
    const resolved = resolve(zone, data);
    if (resolved === undefined) return null;
    const entries = data.entries.get(resolved);
    if (resolved !== "UTC" && entries === undefined) return null;
    const table = entries === undefined ? null : offsetsOf(entries, data);
    return native.setLocalTimeOffsets?.(table) ? resolved : null;
  };
})
