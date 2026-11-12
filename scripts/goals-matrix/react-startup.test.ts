import { expect, test } from "bun:test";
import { reactStartupCommand, reactStartupURL } from "./react-startup";
import { options } from "./run";

test("goals runner accepts an explicit real React URL and rejects an uncalibrated engine", () => {
  expect(options(["--asset-source=test", "--react-startup-url=http://127.0.0.1:48941/"]).reactStartupUrl).toBe("http://127.0.0.1:48941/");
  expect(reactStartupURL(undefined)).toBeUndefined();
  expect(() => reactStartupURL("file:///tmp/site")).toThrow("HTTP");
  expect(() => reactStartupURL("https://example.test/?engine=quickjs")).toThrow("Browser engine");
});

test("goals startup check fixes its budget independently of campaign deadlines", () => {
  const args = reactStartupCommand("https://example.test/", "/results");
  expect(args).toContain("6900");
  expect(args).toContain("30000");
  expect(args).toContain("/results/react-startup.json");
  expect(args).toContain("3");
  expect(args).not.toContain("180000");
});
