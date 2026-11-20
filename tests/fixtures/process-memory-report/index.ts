// process.memoryUsage(), resourceUsage(), bun:jsc memoryUsage() and process.report agree,
// and the report's JavaScript stack names frames as error.stack does.
const { memoryUsage: jscMemoryUsage } = require("bun:jsc");

const usage = process.memoryUsage();
console.log("memoryUsage keys", JSON.stringify(Object.keys(usage)));
console.log("memoryUsage numbers", Object.values(usage).every(value => typeof value === "number" && value >= 0));
// Real figures, not agreeing zeros: a process always has resident memory, a peak, and less than
// all of its address space free.
const MiB = 1024 * 1024;
console.log("rss positive", process.memoryUsage.rss() > MiB, usage.rss > MiB, Math.abs(process.memoryUsage.rss() - usage.rss) < 16 * MiB);
console.log("peak and available", process.resourceUsage().maxRSS * 1024 > MiB, process.availableMemory() > 0, process.availableMemory() !== 2 ** 32);
console.log("bun:jsc keys", JSON.stringify(Object.keys(jscMemoryUsage())));

// Everything is bytes except maxRSS (kilobytes); reads in between allocate, hence the slack.
const slack = 16 * 1024 * 1024;
const near = (a, b) => Math.abs(a - b) < slack;
const rss = process.memoryUsage.rss();
const maxRSS = process.resourceUsage().maxRSS * 1024;
const report = process.report.getReport();
console.log("current agrees", near(jscMemoryUsage().current, rss), near(report.resourceUsage.rss, rss));
console.log("peak agrees", near(jscMemoryUsage().peak, maxRSS), near(report.resourceUsage.maxRss, maxRSS), maxRSS + slack > rss);
console.log("report sections", ["header", "javascriptStack", "javascriptHeap", "nativeStack", "resourceUsage", "libuv", "workers", "environmentVariables", "sharedObjects"].every(key => key in report));
console.log("report header", report.header.reportVersion, report.header.event, report.header.trigger, report.header.processId === process.pid);
console.log("report message", report.javascriptStack.message, report.javascriptStack.errorProperties.code);
console.log("report serializes", typeof JSON.stringify(report));

function names(lines) {
  return lines.slice(0, 2).map(line => /^\s*at (.*?) ?\(/.exec(line)?.[1]);
}
function viaFunction() {
  const reportStack = process.report.getReport().javascriptStack.stack;
  const errorStack = new Error().stack.split("\n").slice(1);
  return { report: names(reportStack), error: names(errorStack) };
}
// Not in tail position, which native JSC would leave out of both stacks.
function outer() {
  const result = viaFunction();
  return result;
}
const frames = outer();
console.log("report frames", frames.report[0], JSON.stringify(frames.report) === JSON.stringify(frames.error));
