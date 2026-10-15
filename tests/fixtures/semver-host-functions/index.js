import { semverIntersects } from "bun:internal-for-testing";

function check(actual, expected) {
  if (actual !== expected) throw new Error(`expected ${expected}, got ${actual}`);
}

check(Bun.semver.satisfies("1.2.3", "^1.0.0"), true);
check(Bun.semver.satisfies("1.2.3-beta.1", "^1.0.0"), false);
check(Bun.semver.satisfies("1.2.3", "1.0.0 || >=1.2.0 <2"), true);
check(Bun.semver.satisfies("no version", "*"), false);
check(Bun.semver.satisfies("1.2.3", "é"), false);
check(Bun.semver.order("1.2.3+left", "1.2.3+right"), 0);
check(Bun.semver.order("1.2.3-beta.2", "1.2.3-beta.11"), -1);
check(Bun.semver.order("2.0.0", "1.0.0"), 1);
check(Bun.semver.order("é", "1.0.0"), 0);
check(semverIntersects("^1.0.0", ">=1.5.0 <3"), true);
check(semverIntersects("^1.0.0", "^2.0.0"), false);

const calls = [];
check(Bun.semver.satisfies({ toString() { calls.push("left"); return "1.2.3"; } }, {
  toString() { calls.push("right"); return "^1"; },
}), true);
check(calls.join(","), "left,right");

for (const method of [Bun.semver.satisfies, Bun.semver.order]) {
  try {
    method(Symbol("version"), "1.0.0");
    throw new Error("expected symbol failure");
  } catch (error) {
    check(error instanceof TypeError, true);
    check(error.message, "Cannot convert a symbol to a string");
  }
}

const marker = new Error("coercion");
try {
  Bun.semver.order({ toString() { throw marker; } }, "1.0.0");
  throw new Error("expected coercion failure");
} catch (error) {
  check(error, marker);
}

for (const input of [[], ["1.0.0"], [Symbol("version"), "1.0.0"]]) {
  try {
    Bun.semver.order(...input);
    throw new Error("expected argument failure");
  } catch (error) {
    check(error.message === "expected argument failure", false);
  }
}

try {
  Bun.semver.order("invalid", "1.0.0");
  throw new Error("expected parse failure");
} catch (error) {
  check(error.message, "Invalid SemVer: invalid\n");
}

for (let i = 0; i < 500; i++) {
  check(Bun.semver.satisfies(`${i}.0.0`, `>=${i}`), true);
}
console.log("semver host functions ok");
