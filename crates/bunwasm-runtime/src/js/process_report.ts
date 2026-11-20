// process.report, after Bun's constructProcessReportObject and Process_functionGetReport
// (src/jsc/bindings/BunProcess.cpp), which follow Node's diagnostic report. The sections a
// guest cannot observe (native stack, libuv handles, CPUs, network interfaces, shared
// objects) are empty, as Bun leaves several of them.
(function (internal: BunWasm.Internal) {
  "use strict";
  type ReportProcess = {
    pid: number; argv: string[]; arch: string; platform: string; cwd(): string; version: string;
    versions: Record<string, string>; release: object; env: Record<PropertyKey, unknown>;
    memoryUsage(): { rss: number; heapTotal: number; heapUsed: number };
    cpuUsage(): { user: number; system: number };
  };
  type Os = { type(): string; release(): string; version(): string; machine(): string; hostname(): string; freemem(): number; totalmem(): number };

  // The caller's frames as error.stack names them, one trimmed "at ..." line each.
  function javascriptStack(skip: Function) {
    const holder: { stack?: string } = {};
    if (typeof Error.captureStackTrace === "function") Error.captureStackTrace(holder, skip);
    else holder.stack = new Error().stack;
    const lines = String(holder.stack ?? "").split("\n").slice(1).map(line => line.trim()).filter(line => line !== "");
    return { message: "Error [ERR_SYNTHETIC]: JavaScript Callstack", stack: lines, errorProperties: { code: "ERR_SYNTHETIC" } };
  }

  function header(process: ReportProcess, os: Os) {
    const now = new Date();
    return {
      reportVersion: 3, event: "JavaScript API", trigger: "GetReport", filename: null,
      dumpEventTime: String(now.getTime()), dumpEventTimeStamp: now.toISOString(), processId: process.pid, threadId: 0,
      cwd: process.cwd(), commandLine: process.argv.slice(), nodejsVersion: process.version, wordSize: 32,
      arch: process.arch, platform: process.platform, componentVersions: Object.assign({}, process.versions),
      release: process.release, osName: os.type(), osRelease: os.release(), osVersion: os.version(), osMachine: os.machine(),
      host: os.hostname(),
    };
  }

  function resourceUsage(process: ReportProcess, os: Os) {
    // A guest's resident size is its linear memory, which never shrinks: the peak is the current value.
    const rss = process.memoryUsage().rss;
    const cpu = process.cpuUsage();
    return {
      free_memory: os.freemem(), total_memory: os.totalmem(), rss, available_memory: os.freemem(),
      userCpuSeconds: cpu.user / 1e6, kernelCpuSeconds: cpu.system / 1e6, cpuConsumptionPercent: 0,
      userCpuConsumptionPercent: 0, kernelCpuConsumptionPercent: 0, maxRss: rss,
      pageFaults: { IORequired: 0, IONotRequired: 0 }, fsActivity: { reads: 0, writes: 0 },
    };
  }

  return function createReport(process: ReportProcess) {
    function getReport() {
      const os = internal.builtin("node:os") as unknown as Os;
      const memory = process.memoryUsage();
      return {
        header: header(process, os),
        javascriptStack: javascriptStack(getReport),
        javascriptHeap: { totalMemory: memory.heapTotal, usedMemory: memory.heapUsed, heapSpaces: {} },
        nativeStack: [],
        resourceUsage: resourceUsage(process, os),
        uvthreadResourceUsage: { userCpuSeconds: 0, kernelCpuSeconds: 0, cpuConsumptionPercent: 0, fsActivity: { reads: 0, writes: 0 } },
        libuv: [],
        workers: [],
        environmentVariables: Object.assign({}, process.env),
        userLimits: {},
        sharedObjects: [],
        cpus: [],
        networkInterfaces: [],
      };
    }
    return {
      compact: false, directory: "", filename: "", reportOnFatalError: false, reportOnSignal: false,
      reportOnUncaughtException: false, signal: "SIGUSR2", excludeNetwork: false, excludeEnv: false,
      getReport,
    };
  };
})
