import { expect, test } from "bun:test";
import { productScoreboard, unlockCandidates, type ProductResultRow } from "./product-report";

test("baseline cannot count native/reference results as browser product passes", () => {
  const rows = [{ app: "vite", engine: "browser", host: "native", stage: "install", status: "pass" }] satisfies ProductResultRow[];
  expect(productScoreboard(rows, [{ id: "vite", commands: [{ name: "dev", check: { kind: "page", hmr: {} } }] }])).toContain("| vite | Not run | Not run | Not run |");
});

test("unlock ranking counts distinct failing projects, not downstream blocked stages", () => {
  const rows = [
    { app: "react", engine: "browser", host: "playground", stage: "dev", status: "fail", blocker: "HTTP 500" },
    { app: "react", engine: "browser", host: "playground", stage: "build", status: "fail", blocker: "HTTP 500" },
    { app: "vue", engine: "browser", host: "playground", stage: "dev", status: "fail", blocker: "HTTP 500" },
    { app: "next", engine: "browser", host: "playground", stage: "dev", status: "blocked", blocker: "HTTP 500" },
  ] satisfies ProductResultRow[];
  expect(unlockCandidates(rows)[0]?.projects).toEqual(["react", "vue"]);
  expect(unlockCandidates(rows)[0]?.confidence).toContain("need confirmation");
});
