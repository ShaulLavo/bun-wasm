import { semver } from "bun";
for (const version of ["1.2.3", "1.3.0", "2.0.0", "0.2.3", "1.2.3-beta.1", "v1.2.3", "invalid", "1.2", "☃"]) {
  console.log(version, ["*", "^1.2.0", "~1.2.0", ">=1.2.3 <2", "1.2.3 || 2.0.0", "1.2 - 1.4", "^0.2", ">=1.2.3-beta.0", "invalid"].map(range => Number(semver.satisfies(version, range))).join(""));
}
for (const [left, right] of [["1.2.3", "2.0.0"], ["2.0.0", "1.2.3"], ["1.2.3+a", "1.2.3+b"], ["1.2.3-beta.1", "1.2.3-beta.2"], ["1.2.3-beta.10", "1.2.3-beta.2"], ["1.2", "1.2.3"], ["☃", "invalid"]]) {
  console.log("order", left, right, semver.order(left, right));
}
console.log("coerce", semver.satisfies({ toString: () => "1.2.3" }, "^1"));
for (const call of [() => semver.satisfies("1"), () => semver.order("1"), () => semver.order("invalid", "1.0.0"), () => semver.satisfies(Symbol(), "*")]) {
  try { call(); } catch (error) { console.log("error", error.name); }
}
