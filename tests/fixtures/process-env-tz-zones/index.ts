// Local time follows process.env.TZ zone by zone, as in Bun: getHours, getTimezoneOffset,
// toString and toTimeString (with the zone's name), locale strings and Intl, for zones with
// daylight saving time (New York, London, Lord Howe's 30-minute shift), fixed offsets
// (Kolkata, Etc/GMT+3), the UTC names, EST5EDT, links, zones FormatJS merges into another
// (Kuala_Lumpur, Jersey, Reunion, Majuro, Nipigon) and Africa/Abidjan's group, which FormatJS
// has no data for. A Date made before a write follows the new zone. An unknown zone keeps the
// previous one, and an empty value or delete restores UTC.
const winter = new Date("2024-01-15T12:00:00Z");
const summer = new Date("2024-07-15T12:00:00Z");
const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const show = (value: Date) => [value.getHours(), value.getMinutes(), value.getTimezoneOffset(), value.toString(), value.toTimeString(), value.toLocaleString("en-US"), value.toLocaleTimeString("en-US")].join(" | ");

console.log("start", zone(), "|", show(winter));
// Africa/Abidjan as the first zone: FormatJS's data has no entry for it.
process.env.TZ = "Africa/Abidjan";
console.log("first Africa/Abidjan ->", zone(), "|", show(winter));
const zones = ["America/New_York", "Europe/London", "Australia/Lord_Howe", "Asia/Kolkata", "Etc/GMT+3", "GMT", "Etc/UTC", "EST5EDT", "US/Pacific", "asia/tokyo", "Asia/Calcutta", "Europe/Berlin", "Pacific/Chatham", "Africa/Casablanca", "Etc/Unknown", "Factory"];
// A UTC name after another zone, Africa/Abidjan's group, merged zones, current names, and one
// of FormatJS's rule names, which Bun does not know.
// Each unknown name follows a zone it must leave in place.
const more = ["Asia/Tokyo", "Zulu", "Asia/Tokyo", "GMT0", "Asia/Tokyo", "Etc/Greenwich", "Africa/Dakar", "Iceland", "Africa/Abidjan", "Asia/Tokyo", "Africa/Abidjan", "Asia/Kuala_Lumpur", "Not/AZone", "Europe/Jersey", "Indian/Reunion", "Pacific/Majuro", "America/Nipigon", "America/Argentina/ComodRivadavia", "America/Coyhaique", "Asia/Almaty", "Asia/Qostanay", "1918"];
for (const name of zones.concat(more)) {
  process.env.TZ = name;
  console.log(`${name} -> ${zone()}`);
  console.log("  winter", show(winter));
  console.log("  summer", show(summer));
}

// Names of past eras: the same zone and offset can have another name in another year.
for (const [name, iso] of [["America/Mexico_City", "2020-07-15"], ["Asia/Tehran", "2020-07-15"], ["Asia/Tehran", "2020-01-15"], ["Europe/Moscow", "2010-07-15"], ["Europe/Moscow", "2012-01-15"], ["America/Sao_Paulo", "2018-01-15"], ["Europe/Istanbul", "2015-07-15"], ["Asia/Almaty", "2000-01-15"], ["Europe/London", "1975-07-15"]]) {
  process.env.TZ = name;
  console.log("past", name, new Date(`${iso}T12:00:00Z`).toString());
}

// Transitions: Lord Howe moves 30 minutes, New York an hour; local fields in a gap and in an overlap.
process.env.TZ = "Australia/Lord_Howe";
for (const iso of ["2024-04-06T14:59:00Z", "2024-04-06T15:00:00Z", "2024-10-05T15:29:00Z", "2024-10-05T15:30:00Z"]) {
  const value = new Date(iso);
  console.log("Lord Howe", iso, value.getHours(), value.getMinutes(), value.getTimezoneOffset());
}
process.env.TZ = "America/New_York";
for (const [label, value] of [["gap", new Date(2024, 2, 10, 2, 30)], ["overlap", new Date(2024, 10, 3, 1, 30)], ["plain", new Date(2024, 0, 15, 9)], ["UTC fields", new Date(Date.UTC(2024, 6, 4))]] as const) {
  console.log("New York local", label, value.toISOString(), value.getHours(), value.getTimezoneOffset());
}
const setter = new Date("2024-03-10T06:00:00Z");
setter.setHours(2, 30);
console.log("setHours into the gap", setter.toISOString());
console.log("parsed local", new Date("2024-07-04T12:00:00").toISOString(), new Date("July 4, 2024 12:00").getTime());
console.log("far future", new Date("2060-07-15T12:00:00Z").getTimezoneOffset(), new Date("2060-01-15T12:00:00Z").getTimezoneOffset());
console.log("before 1970", new Date("1960-07-15T12:00:00Z").getTimezoneOffset(), new Date("1900-01-15T12:00:00Z").getHours());

// Unknown zones, an empty value and delete.
process.env.TZ = "Asia/Kolkata";
for (const name of ["Not/AZone", "Mars/Olympus", "+05:30"]) {
  process.env.TZ = name;
  console.log("unknown", name, winter.getHours(), winter.getMinutes(), zone());
}
process.env.TZ = "";
console.log("empty", winter.getHours(), winter.getTimezoneOffset(), zone(), winter.toString());
process.env.TZ = "Asia/Kolkata";
delete process.env.TZ;
console.log("deleted", winter.getHours(), winter.getTimezoneOffset(), zone(), "TZ" in process.env);

// Locale strings with no arguments, first used here because Bun keeps the zone of its first
// such call: midnight, noon, an ordinary time and an invalid date. Date() as a function, and
// the methods' lengths.
process.env.TZ = "Asia/Kolkata";
for (const iso of ["2024-01-14T18:30:00Z", "2024-01-15T06:30:00Z", "2024-07-15T12:34:56Z", "invalid"]) {
  const value = new Date(iso);
  console.log("default locale", value.toLocaleString(), "|", value.toLocaleDateString(), "|", value.toLocaleTimeString());
}
console.log("Date()", typeof Date(), / GMT\+0530 \(India Standard Time\)$/.test(Date()));
console.log("lengths", Date.prototype.toLocaleString.length, Date.prototype.toLocaleDateString.length, Date.prototype.toLocaleTimeString.length);
