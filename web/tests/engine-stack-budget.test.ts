import { expect, test } from "bun:test";
import { effectiveParserReserve, engineStackBudgets, hostArchitecture, jscParserReserve, pageFacts, qualifiedParserReserves, stackHost, type HostArchitecture, type QualifiedParserReserves } from "../src/engine-stack-budget";

const firefox = "Mozilla/5.0 (X11; Linux x86_64; rv:144.0) Gecko/20100101 Firefox/144.0";
const firefoxMac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:157.0) Gecko/20100101 Firefox/157.0";
const firefoxWindows = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:157.0) Gecko/20100101 Firefox/157.0";
const safari = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.4 Safari/605.1.15";
const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.4 Mobile/15E148 Safari/604.1";
const ipad = "Mozilla/5.0 (iPad; CPU OS 26_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.4 Mobile/15E148 Safari/604.1";
const geckoStack = "engineStackBudgets@http://localhost/worker.js:10:2\n@http://localhost/worker.js:20:1";
const v8Stack = "Error\n    at createBunExecutor (worker.js:10:2)";
const noTouch = { maxTouchPoints: 0 };
const conservative = { quickjs: "32", jsc: "192" };
// A value for every family that may ever carry one, so each row shows what it would select.
const everyFamily: QualifiedParserReserves = {
  "firefox-linux": { bytes: "1024" }, "firefox-desktop": { bytes: "1040" }, "safari-macos": { bytes: "1056", minimumSafariMajor: 26 },
};

test.each([
  { host: "Linux", agent: firefox },
  { host: "Windows", agent: firefoxWindows },
  { host: "macOS", agent: firefoxMac },
])("desktop Firefox on $host keeps QuickJS's default and the measured JSC budget", ({ agent }) => {
  expect(engineStackBudgets(geckoStack, agent)).toEqual({ jsc: "208" });
});

test("Safari and unmeasured hosts retain both conservative stack budgets", () => {
  expect(engineStackBudgets(geckoStack, safari)).toEqual(conservative);
  expect(engineStackBudgets(geckoStack, "Mozilla/5.0 AppleWebKit/605.1.15 FxiOS/144.0 Mobile Safari/605.1.15")).toEqual(conservative);
  expect(engineStackBudgets("", "")).toEqual(conservative);
});

test("V8 gives JSC getter reentry room while keeping QuickJS at its default", () => {
  expect(engineStackBudgets(v8Stack, "Chrome/157.0.0.0")).toEqual({ jsc: "800" });
});

test.each([
  { host: "Android phone", agent: "Mozilla/5.0 (Android 4.4; Mobile; rv:41.0) Gecko/41.0 Firefox/41.0" },
  { host: "Android tablet", agent: "Mozilla/5.0 (Android 14; Tablet; rv:157.0) Gecko/157.0 Firefox/157.0" },
  { host: "mobile desktop-style UA", agent: "Mozilla/5.0 (X11; Linux x86_64; Mobile; rv:157.0) Gecko/20100101 Firefox/157.0" },
  { host: "unknown Firefox platform", agent: "Mozilla/5.0 Gecko/20100101 Firefox/157.0" },
])("$host keeps both conservative stack budgets", ({ agent }) => {
  expect(engineStackBudgets(geckoStack, agent)).toEqual(conservative);
});

// One case per row of the host table in docs/stack-limits.md.
test.each([
  { row: "V8", stack: v8Stack, agent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/157.0.0.0 Safari/537.36", page: noTouch, host: "v8", budgets: { jsc: "800" }, reserve: undefined },
  { row: "desktop Firefox on Linux", stack: geckoStack, agent: firefox, page: undefined, host: "firefox-linux", budgets: { jsc: "208" }, reserve: "1024" },
  { row: "desktop Firefox on macOS", stack: geckoStack, agent: firefoxMac, page: noTouch, host: "firefox-desktop", budgets: { jsc: "208" }, reserve: "1040" },
  { row: "desktop Firefox on Windows", stack: geckoStack, agent: firefoxWindows, page: noTouch, host: "firefox-desktop", budgets: { jsc: "208" }, reserve: "1040" },
  { row: "macOS Safari with the zero-touch fact", stack: geckoStack, agent: safari, page: noTouch, host: "safari-macos", budgets: conservative, reserve: "1056" },
  { row: "iPhone", stack: geckoStack, agent: iphone, page: { maxTouchPoints: 5 }, host: "other", budgets: conservative, reserve: undefined },
  { row: "iPad in mobile mode", stack: geckoStack, agent: ipad, page: { maxTouchPoints: 5 }, host: "other", budgets: conservative, reserve: undefined },
  { row: "iPad in desktop mode, reporting its touch points", stack: geckoStack, agent: safari, page: { maxTouchPoints: 5 }, host: "other", budgets: conservative, reserve: undefined },
  { row: "iPad in desktop mode, or any Macintosh Safari, with no touch-point fact", stack: geckoStack, agent: safari, page: undefined, host: "other", budgets: conservative, reserve: undefined },
  { row: "Chrome on iOS", stack: geckoStack, agent: "Mozilla/5.0 (iPhone; CPU iPhone OS 26_4 like Mac OS X) AppleWebKit/605.1.15 CriOS/157.0 Mobile/15E148 Safari/604.1", page: noTouch, host: "other", budgets: conservative, reserve: undefined },
  { row: "Firefox on iOS", stack: geckoStack, agent: "Mozilla/5.0 (iPhone; CPU iPhone OS 26_4 like Mac OS X) AppleWebKit/605.1.15 FxiOS/147.0 Mobile/15E148 Safari/605.1.15", page: noTouch, host: "other", budgets: conservative, reserve: undefined },
  { row: "Edge on iOS with a desktop-style agent", stack: geckoStack, agent: `${safari} EdgiOS/131.0`, page: noTouch, host: "other", budgets: conservative, reserve: undefined },
  { row: "Android Firefox", stack: geckoStack, agent: "Mozilla/5.0 (Android 14; Mobile; rv:157.0) Gecko/157.0 Firefox/157.0", page: noTouch, host: "other", budgets: conservative, reserve: undefined },
  { row: "unknown host", stack: geckoStack, agent: "Unknown/1.0", page: noTouch, host: "other", budgets: conservative, reserve: undefined },
] as const)("$row selects its own row of the host table", ({ stack, agent, page, host, budgets, reserve }) => {
  expect(stackHost(stack, agent, page)).toBe(host);
  expect(engineStackBudgets(stack, agent)).toEqual(budgets);
  expect(jscParserReserve(stack, agent, page, everyFamily)).toBe(reserve);
});

test("a qualified Safari value needs at least the measured Safari version", () => {
  const older = safari.replace("Version/26.4", "Version/18.6");
  expect(stackHost(geckoStack, older, noTouch)).toBe("safari-macos");
  expect(jscParserReserve(geckoStack, older, noTouch, everyFamily)).toBeUndefined();
  expect(jscParserReserve(geckoStack, safari.replace("Version/26.4", "Version/27.0"), noTouch, everyFamily)).toBe("1056");
});

test("a family without a qualified value never borrows another family's", () => {
  const onlyFirefoxLinux: QualifiedParserReserves = { "firefox-linux": { bytes: "1024" } };
  for (const agent of [firefoxMac, firefoxWindows, safari, iphone, "Unknown/1.0"]) {
    expect(jscParserReserve(geckoStack, agent, noTouch, onlyFirefoxLinux)).toBeUndefined();
  }
  expect(jscParserReserve(v8Stack, firefox, noTouch, onlyFirefoxLinux)).toBeUndefined();
});

test("the shipped table carries only values that passed their own family's qualification", () => {
  expect(Object.keys(qualifiedParserReserves).toSorted()).toEqual(["firefox-linux", "safari-macos"]);
  expect(qualifiedParserReserves.other).toBeUndefined();
  expect(qualifiedParserReserves["safari-macos"]).toMatchObject({ minimumSafariMajor: 26, architecture: "arm64" });
  for (const entry of Object.values(qualifiedParserReserves)) expect(effectiveParserReserve(entry.bytes)).toBe(Number(entry.bytes));
});

test("the shipped Safari value reaches only Apple silicon macOS Safari 26 or later with the zero-touch fact", () => {
  const shipped = (agent: string, page?: { maxTouchPoints: number }, architecture: HostArchitecture = "arm64") =>
    jscParserReserve(geckoStack, agent, page, qualifiedParserReserves, () => architecture);
  expect(shipped(safari, noTouch)).toBe("832");
  expect(shipped(safari.replace("Version/26.4", "Version/27.0"), noTouch)).toBe("832");
  expect(shipped(safari.replace("Version/26.4", "Version/18.6"), noTouch)).toBeUndefined();
  expect(shipped(safari)).toBeUndefined();
  expect(shipped(safari, { maxTouchPoints: 5 })).toBeUndefined();
  for (const agent of [iphone, ipad, firefoxMac, "Unknown/1.0"]) expect(shipped(agent, noTouch)).toBeUndefined();
  // An Intel Mac sends the same Safari identity. It keeps the default, and so does an unreadable host.
  expect(shipped(safari, noTouch, "x86")).toBeUndefined();
  expect(shipped(safari, noTouch, "unknown")).toBeUndefined();
  // Firefox's value does not depend on the processor.
  expect(jscParserReserve(geckoStack, firefox, undefined, qualifiedParserReserves, () => "unknown")).toBe("960");
});

test("the worker reads its own processor family from a float division", () => {
  const expected = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x86" : "unknown";
  expect(hostArchitecture()).toBe(expected);
  expect(hostArchitecture()).toBe(expected);
});

test("page facts exist only where the page can read its touch points", () => {
  const navigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  try {
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { platform: "MacIntel", vendor: "Apple Computer, Inc.", maxTouchPoints: 0 } });
    expect(pageFacts()).toEqual({ platform: "MacIntel", vendor: "Apple Computer, Inc.", maxTouchPoints: 0 });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: undefined });
    expect(pageFacts()).toBeUndefined();
  } finally {
    if (navigator) Object.defineProperty(globalThis, "navigator", navigator);
    else Reflect.deleteProperty(globalThis, "navigator");
  }
});

test.each([
  { value: undefined, bytes: 2048 }, { value: "", bytes: 2048 }, { value: "0", bytes: 2048 }, { value: "511", bytes: 2048 },
  { value: "2049", bytes: 2048 }, { value: "01024", bytes: 2048 }, { value: "+1024", bytes: 2048 }, { value: "-1024", bytes: 2048 },
  { value: " 1024", bytes: 2048 }, { value: "1024 ", bytes: 2048 }, { value: "1024.0", bytes: 2048 }, { value: "1024kb", bytes: 2048 },
  { value: "1e3", bytes: 2048 }, { value: "0x400", bytes: 2048 }, { value: "512", bytes: 512 }, { value: "513", bytes: 528 },
  { value: "1000", bytes: 1008 }, { value: "1024", bytes: 1024 }, { value: "0512", bytes: 512 }, { value: "2033", bytes: 2048 },
  { value: "2048", bytes: 2048 },
])("a parser reserve setting of $value means $bytes bytes", ({ value, bytes }) => {
  expect(effectiveParserReserve(value)).toBe(bytes);
});

const desktopSafari = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.4 Safari/605.1.15";
const desktopHost = { platform: "MacIntel", vendor: "Apple Computer, Inc.", maxTouchPoints: 0 };

test("positively observed desktop Safari selects only the measured QuickJS headroom", () => {
  expect(engineStackBudgets(geckoStack, desktopSafari, desktopHost)).toEqual({ quickjs: "36", jsc: "192" });
});

test.each([
  { name: "missing page observations", agent: desktopSafari, host: undefined },
  { name: "desktop-style iPad", agent: desktopSafari, host: { ...desktopHost, maxTouchPoints: 5 } },
  { name: "missing touch observation", agent: desktopSafari, host: { platform: "MacIntel", vendor: desktopHost.vendor } },
  { name: "missing vendor", agent: desktopSafari, host: { platform: "MacIntel", maxTouchPoints: 0 } },
  { name: "missing platform", agent: desktopSafari, host: { vendor: desktopHost.vendor, maxTouchPoints: 0 } },
  { name: "unknown platform", agent: desktopSafari, host: { ...desktopHost, platform: "" } },
  { name: "non-Apple vendor", agent: desktopSafari, host: { ...desktopHost, vendor: "Google Inc." } },
  { name: "iPhone", agent: "Mozilla/5.0 (iPhone; CPU iPhone OS 26_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.4 Mobile/15E148 Safari/604.1", host: desktopHost },
  { name: "iPad", agent: "Mozilla/5.0 (iPad; CPU OS 26_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.4 Mobile/15E148 Safari/604.1", host: desktopHost },
  { name: "unknown WebKit", agent: "Mozilla/5.0 AppleWebKit/605.1.15 Safari/605.1.15", host: desktopHost },
  { name: "Safari-lookalike with Chrome", agent: desktopSafari + " Chrome/157.0", host: desktopHost },
  { name: "Safari-lookalike with Firefox iOS", agent: desktopSafari + " FxiOS/157.0", host: desktopHost },
  { name: "Safari-lookalike with Edge", agent: desktopSafari + " Edg/157.0", host: desktopHost },
])("$name retains conservative budgets", ({ agent, host }) => {
  expect(engineStackBudgets(geckoStack, agent, host)).toEqual({ quickjs: "32", jsc: "192" });
});

test("page observations do not change V8 or Firefox choices", () => {
  expect(engineStackBudgets("Error\n    at worker.js:1:1", desktopSafari, desktopHost)).toEqual({ jsc: "800" });
  expect(engineStackBudgets(geckoStack, firefox, desktopHost)).toEqual({ jsc: "208" });
});
