export const cases = [
  { name: "order", pass: 4, fail: 0, errors: 0, events: ["before", "after", "root TLA", "A enter", "A resume", "after nested call", "nested enter", "nested resume", "B enter", "nested body", "A body", "B body", "sentinel"] },
  { name: "duplicate", pass: 3, fail: 0, errors: 0, events: ["duplicate collect", "duplicate collect", "duplicate body", "duplicate body", "sentinel"] },
  { name: "disabled", pass: 1, fail: 0, errors: 0, events: ["skip enter", "skip resume", "todo enter", "todo resume", "sentinel"] },
  { name: "reject", pass: 2, fail: 0, errors: 1, events: ["bad enter", "bad reject", "good enter", "good body", "sentinel"] },
  { name: "test-only", pass: 0, fail: 0, errors: 1, events: ["bad enter", "bad reject", "good enter"] },
  { name: "describe-only", pass: 0, fail: 0, errors: 1, events: ["bad enter", "bad reject", "good enter"] },
  { name: "nested-only", pass: 0, fail: 0, errors: 1, events: ["bad enter", "bad reject", "good enter"] },
  { name: "good-only", pass: 1, fail: 0, errors: 1, events: ["bad enter", "bad reject", "good enter", "good body"] },
  { name: "cache", pass: 2, fail: 0, errors: 1, events: ["module enter", "module resume", "second body", "sentinel"] },
  { name: "intrinsic", pass: 1, fail: 0, errors: 1, events: ["sentinel"] },
  { name: "preload", pass: 2, fail: 0, errors: 0, events: ["preload enter", "preload resume", "root after import", "queued enter", "queued resume", "preload beforeAll", "owned body", "sentinel"] },
  { name: "root-reject", pass: 0, fail: 1, errors: 1, events: ["root reject"] },
] as const;
