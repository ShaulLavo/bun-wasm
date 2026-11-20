// process.env.TZ for QuickJS, whose local time comes from wasi-libc and is always UTC. The zone
// is resolved and its transitions read from the zone data the fallback Intl already ships
// (tz_data.js, FormatJS's add-all-tz): the timeZoneEntries native finds the one zone in the
// embedded text (crates/bunwasm-runtime/src/time_zone.rs), so the 1.36 MB module is never parsed
// for TZ. The engine applies the offsets to Date (JS_bunwasm_SetLocalTimeOffsets in quickjs.c).
// The zone ID is the one Bun reports: links resolve to their zone, the UTC names to UTC, and
// zone_ids.js names the zones FormatJS merges into another (scripts/generate-zone-names.ts).
(function (internal: BunWasm.Internal) {
  "use strict";
  // tzdata 2024b made these POSIX-style zones links to their cities, and ICU resolves them so.
  // FormatJS's data predates that and has no entry for them.
  const cityLinks = new Map([
    ["EST5EDT", "America/New_York"], ["CST6CDT", "America/Chicago"],
    ["MST7MDT", "America/Denver"], ["PST8PDT", "America/Los_Angeles"],
  ]);
  // The names that are UTC, answered without the zone data: test harnesses and CI often start
  // every process with one of them. Bun reads Etc/Unknown and Factory as UTC too.
  const utcNames = new Set(["", "UTC", "Etc/UTC", "GMT", "Etc/GMT", "Etc/Unknown", "Factory"]);
  let offsets: number[] | undefined;
  let ids: Record<string, string> | undefined;

  type Zone = { table: number[]; dstTimes: number[]; dstFlags: boolean[] };

  // A zone's offsets as `[offset, time, offset, ...]` (seconds) for the engine, and the times its
  // daylight flag changes, for the zone's name. FormatJS lists `time,abbreviation,offset,dst`
  // entries in order; the first has no time, and a final "NaN" entry keeps the last offset.
  function zoneOf(entries: string): Zone {
    offsets ??= internal.native.timeZoneOffsets!()!.split("|").map(offset => parseInt(offset, 36));
    const zone: Zone = { table: [], dstTimes: [], dstFlags: [] };
    for (const entry of entries.split("|")) {
      const [time, , offsetIndex, dst] = entry.split(",");
      if (time === "NaN") continue;
      const seconds = time === "" ? -Infinity : parseInt(time!, 36);
      const offset = offsets[Number(offsetIndex)]!;
      if (zone.table.length === 0) zone.table.push(offset);
      else if (offset !== zone.table[zone.table.length - 1]) zone.table.push(seconds, offset);
      if (zone.dstFlags[zone.dstFlags.length - 1] === (dst === "1")) continue;
      zone.dstTimes.push(seconds);
      zone.dstFlags.push(dst === "1");
    }
    return zone;
  }

  // Whether daylight time applies at a UTC instant in the zone now in use.
  function daylight(zone: Zone, ms: number): boolean {
    const seconds = ms / 1000;
    let low = 0;
    let high = zone.dstTimes.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (zone.dstTimes[middle]! <= seconds) low = middle + 1;
      else high = middle;
    }
    return low > 0 && zone.dstFlags[low - 1]!;
  }

  function useUtc(): string {
    internal.native.setLocalTimeOffsets?.(null);
    internal.localTimeZoneDaylight = undefined;
    return (internal.localTimeZone = "UTC");
  }

  // The zone ID now in use, or null when `zone` names no zone (the previous zone stays). An
  // empty name restores the start zone, UTC. `internal.localTimeZone` names it for toString, and
  // `internal.localTimeZoneDaylight` tells its daylight time apart. Names are case-sensitive, as
  // ICU is for JavaScriptCore: Bun keeps the previous zone for "asia/tokyo".
  return function applyTimeZone(zone: string): string | null {
    if (utcNames.has(zone)) return useUtc();
    const name = cityLinks.get(zone) ?? zone;
    // FormatJS's data lacks Africa/Abidjan, the zone of its West African and Icelandic links.
    const found: [zone: string, entries: string | undefined] | undefined = name === "Africa/Abidjan" ? [name, undefined] : internal.native.timeZoneEntries?.(name);
    if (!found) return null;
    const [target] = found;
    let entries = found[1];
    // Bun's zone is the data's, except for the few names zone_ids.js lists (America/Nipigon is
    // America/Toronto in Bun although FormatJS keeps its entries).
    const id = (ids ??= internal.require("zone_ids"))[name] ?? target;
    // A name in the data that Bun does not know (America/Argentina/ComodRivadavia).
    if (id === "") return null;
    if (id === "UTC" || target === "Etc/UTC" || target === "Etc/GMT") return useUtc();
    if (id !== target) {
      const own = internal.native.timeZoneEntries?.(id);
      if (own?.[0] === id && own[1] !== undefined) entries = own[1];
    }
    // Without entries only Africa/Abidjan's group is a zone (GMT all along); "1918", one of
    // FormatJS's rule names, is not.
    if (entries === undefined && target !== "Africa/Abidjan") return null;
    const resolved = entries === undefined ? { table: [0], dstTimes: [], dstFlags: [] } : zoneOf(entries);
    if (!internal.native.setLocalTimeOffsets?.(resolved.table)) return null;
    internal.localTimeZoneDaylight = (ms: number) => daylight(resolved, ms);
    return (internal.localTimeZone = id);
  };
})
