import { expect, test } from "bun:test";
import { isNextDistTagsRequest, nextDistTags, nextDistTagsResponse } from "./next-framework-offline";

const deniedURLs = [
  "https://registry.npmjs.org/-/package/next/dist-tags/",
  "https://registry.npmjs.org/-/package/next/dist-tag",
  "https://registry.npmjs.org/-/package/next/dist-tags?query=1",
  "https://registry.npmjs.org/-/package/next/dist-tags?",
  "https://registry.npmjs.org/-/package/react/dist-tags",
  "https://registry.npmjs.org.example.com/-/package/next/dist-tags",
  "https://example.com/-/package/next/dist-tags",
  "http://registry.npmjs.org/-/package/next/dist-tags",
];

test("offline metadata matches only the exact pinned Next URL and GET", async () => {
  expect(isNextDistTagsRequest(nextDistTags.requestURL, "GET")).toBe(true);
  for (const url of deniedURLs) expect(isNextDistTagsRequest(url, "GET")).toBe(false);
  expect(isNextDistTagsRequest(nextDistTags.requestURL, "POST")).toBe(false);
  const response = nextDistTagsResponse(new Request("http://127.0.0.1" + nextDistTags.registryPath));
  expect(response).not.toBeNull();
  expect(await response?.json()).toEqual({ latest: "15.5.6", canary: "15.5.6" });
  expect(nextDistTags.provenance).toContain("not live npm tags");
});

test("the injected registry policy denies neighboring paths, queries and methods", () => {
  for (const path of [nextDistTags.registryPath + "/", nextDistTags.registryPath + "?query=1", nextDistTags.registryPath + "?", "/-/package/react/dist-tags"]) {
    expect(nextDistTagsResponse(new Request("http://127.0.0.1" + path))).toBeNull();
  }
  expect(nextDistTagsResponse(new Request("http://127.0.0.1" + nextDistTags.registryPath, { method: "POST" }))).toBeNull();
  expect(nextDistTagsResponse(new Request("http://example.com" + nextDistTags.registryPath))).toBeNull();
});
