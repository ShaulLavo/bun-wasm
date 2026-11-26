import { expect, test } from "bun:test";
import { isCancelledLoadingStatusPoll } from "./preview-loading-noise";

/** The `name` and `message` Playwright's WebKit driver builds from a console error text. */
function pageError(text: string): { name: string; message: string } {
  const colon = text.indexOf(":");
  return { name: text.slice(0, colon), message: text.slice(colon + 2) };
}

const id = "0ecd4070-7053-4104-b507-46e6e141c9ca";

test("matches WebKit's cancelled loading-status poll at the root and under /sandbox", () => {
  // The exact text WebKit logged in CI run 45689322779, rebuilt from Playwright's split.
  expect(isCancelledLoadingStatusPoll(pageError(`Fetch API cannot load http://127.0.0.1:36821/sandbox/__preview/.loading/${id}/status due to access control checks.`))).toBe(true);
  expect(isCancelledLoadingStatusPoll(pageError(`Fetch API cannot load http://127.0.0.1:44729/__preview/.loading/${id}/status due to access control checks.`))).toBe(true);
  // Playwright's own split of the CI message: name "Fetch API cannot load http", message "/127.0.0.1…".
  expect(isCancelledLoadingStatusPoll({ name: "Fetch API cannot load http", message: `/127.0.0.1:36821/sandbox/__preview/.loading/${id}/status due to access control checks.` })).toBe(true);
});

test("rejects an application error that only ends like the WebKit diagnostic", () => {
  expect(isCancelledLoadingStatusPoll({ name: "Error", message: `boom /__preview/.loading/${id}/status due to access control checks.` })).toBe(false);
  expect(isCancelledLoadingStatusPoll(pageError(`TypeError: Fetch API cannot load http://127.0.0.1:1/__preview/.loading/${id}/status due to access control checks.`))).toBe(false);
  expect(isCancelledLoadingStatusPoll(pageError(`Fetch API cannot load http://127.0.0.1:1/__preview/.loading/${id}/status due to access control checks. Then the app crashed.`))).toBe(false);
});

test("rejects a URL whose loading-status path is only in the query or hash", () => {
  expect(isCancelledLoadingStatusPoll(pageError(`Fetch API cannot load http://127.0.0.1:1/api?next=/__preview/.loading/${id}/status due to access control checks.`))).toBe(false);
  expect(isCancelledLoadingStatusPoll(pageError(`Fetch API cannot load http://127.0.0.1:1/__preview/.loading/${id}/status?x=1 due to access control checks.`))).toBe(false);
  expect(isCancelledLoadingStatusPoll(pageError(`Fetch API cannot load http://127.0.0.1:1/other/__preview/.loading/${id}/status due to access control checks.`))).toBe(false);
  expect(isCancelledLoadingStatusPoll(pageError(`Fetch API cannot load http://127.0.0.1:1/__preview/.loading/${id}/cancel/1 due to access control checks.`))).toBe(false);
});

test("rejects an id that is not a UUID", () => {
  const hyphens = "-".repeat(36);
  expect(isCancelledLoadingStatusPoll(pageError(`Fetch API cannot load http://127.0.0.1:1/__preview/.loading/${hyphens}/status due to access control checks.`))).toBe(false);
  expect(isCancelledLoadingStatusPoll(pageError(`Fetch API cannot load http://127.0.0.1:1/__preview/.loading/${id.toUpperCase().replace("0", "g")}/status due to access control checks.`))).toBe(false);
});
