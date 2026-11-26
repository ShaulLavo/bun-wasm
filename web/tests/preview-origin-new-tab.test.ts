import { expect, test } from "bun:test";
import { namesNewTab, newTabLink, opensAside } from "../src/preview-origin/new-tab";
import { wrapperLink } from "../src/preview-origin/protocol";

const ORIGIN = `https://${"a".repeat(52)}-5173-pv.sprockt.dev`;
const WRAPPER = `https://bun.sprockt.dev/sandbox/preview-frame.html?preview-origin=https%3A%2F%2Fsprockt.dev&url=${encodeURIComponent(`${ORIGIN}/`)}`;
const link = (destination: string | URL | undefined, base = `${ORIGIN}/reports/list`) => newTabLink(WRAPPER, destination, base, ORIGIN);
const target = (wrapped: string | null) => (wrapped === null ? null : new URL(wrapped).searchParams.get("url"));

test("a page of the app's own origin opens through the IDE's wrapper page, at the URL the app asked for", () => {
  const wrapped = link("/report?id=7&x=a b#totals");
  expect(wrapped).toStartWith("https://bun.sprockt.dev/sandbox/preview-frame.html?preview-origin=https%3A%2F%2Fsprockt.dev&url=");
  expect(target(wrapped)).toBe(`${ORIGIN}/report?id=7&x=a%20b#totals`);
  // Relative to the document's base, as the browser resolves a link or a window.open argument.
  expect(target(link("print"))).toBe(`${ORIGIN}/reports/print`);
  expect(target(link("print", `${ORIGIN}/app/`))).toBe(`${ORIGIN}/app/print`);
  expect(target(link(new URL(`${ORIGIN}/x`)))).toBe(`${ORIGIN}/x`);
  expect(target(link(`${ORIGIN}/`))).toBe(`${ORIGIN}/`);
});

test("anything that is not a page of this origin opens as the app wrote it", () => {
  for (const destination of [
    undefined, "", "about:blank", "https://example.com/", `https://${"b".repeat(52)}-5173-pv.sprockt.dev/`, `http://${new URL(ORIGIN).host}/`,
    `blob:${ORIGIN}/3f1c`, "data:text/html,<p>x</p>", "javascript:void 0", "mailto:a@example.com", "https://[bad",
  ]) expect(link(destination)).toBeNull();
});

test("a wrapper link is made only from an http(s) wrapper URL, and keeps that page's other parameters", () => {
  expect(wrapperLink("https://ide.example/frame?theme=dark&url=old", `${ORIGIN}/a?b=1`)).toBe(`https://ide.example/frame?theme=dark&url=${encodeURIComponent(`${ORIGIN}/a?b=1`)}`);
  for (const wrapper of ["", "javascript:alert(1)", "data:text/html,x", "not a url"]) expect(wrapperLink(wrapper, `${ORIGIN}/`)).toBeNull();
});

test("a target names a new tab unless it is the frame itself, its ancestors, or a frame in reach", () => {
  const frames = (name: string) => name === "sidebar";
  for (const name of ["_blank", "_BLANK", "report", "popup-1"]) expect(namesNewTab(name, frames)).toBe(true);
  for (const name of ["", "_self", "_parent", "_top", "_TOP", "sidebar"]) expect(namesNewTab(name, frames)).toBe(false);
});

test("a middle click or a click with Ctrl, Cmd or Shift opens aside whatever the link's target", () => {
  const plain = { button: 0, ctrlKey: false, metaKey: false, shiftKey: false };
  expect(opensAside(plain)).toBe(false);
  for (const change of [{ button: 1 }, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }]) expect(opensAside({ ...plain, ...change })).toBe(true);
});
