// process.env.TZ for QuickJS, whose local time comes from wasi-libc and is always UTC. The zone
// is resolved and its transitions read from the zone data the fallback Intl already ships
// (tz_data.js, FormatJS's add-all-tz): the timeZoneEntries native finds the one zone in the
// embedded text (crates/bunwasm-runtime/src/time_zone.rs), so the 1.36 MB module is never parsed
// for TZ. The engine applies the offsets to Date (JS_bunwasm_SetLocalTimeOffsets in quickjs.c).
// Names resolve as ICU resolves them for JavaScriptCore: links to their zone, GMT, Etc/UTC,
// Etc/Unknown and Factory to UTC.
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

  // A zone's offsets as `[offset, time, offset, ...]` (seconds): the first offset applies from
  // the beginning, each later one from its time on. FormatJS lists `time,abbreviation,offset,dst`
  // entries in order; the first has no time, and a final "NaN" entry keeps the last offset.
  function offsetsOf(entries: string): number[] {
    offsets ??= internal.native.timeZoneOffsets!()!.split("|").map(offset => parseInt(offset, 36));
    const table: number[] = [];
    for (const entry of entries.split("|")) {
      const [time, , offsetIndex] = entry.split(",");
      const offset = offsets[Number(offsetIndex)]!;
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
  // empty name restores the start zone, UTC. `internal.localTimeZone` names it for toString.
  // Names are case-sensitive, as ICU is for JavaScriptCore: Bun keeps the previous zone for
  // "asia/tokyo".
  return function applyTimeZone(zone: string): string | null {
    const native = internal.native;
    if (utcNames.has(zone)) {
      native.setLocalTimeOffsets?.(null);
      return (internal.localTimeZone = "UTC");
    }
    const found = native.timeZoneEntries?.(cityLinks.get(zone) ?? zone);
    if (!found) return null;
    const resolved = found[0] === "Etc/UTC" || found[0] === "Etc/GMT" ? "UTC" : found[0];
    if (!native.setLocalTimeOffsets?.(resolved === "UTC" ? null : offsetsOf(found[1]))) return null;
    return (internal.localTimeZone = resolved);
  };
})
