import { cpus, release } from "node:os";

export const TIMING_PREFIX = "BUN_WASM_TIMING_V1 ";
export const timingWorkloads = {
  "diagnostic-controller-progress": "v1:three-bytes;EAGAIN-until-setImmediate;drain-complete",
  "http-stream-cancel": "v1:Chromium-loopback;250ms-stream-delay;EOF-cancel-followup;excludes-launch-and-close",
} as const;

export type TimingSample = {
  schema: 1;
  metric: keyof typeof timingWorkloads;
  workload: string;
  sourceSha: string;
  elapsedMs: number;
  outcome: "pass";
  environment: {
    os: string; arch: string; kernel: string; cpu: string; cores: number;
    runner: string; image: string; imageVersion: string;
    runtime: string; browser: string;
  };
};

export function emitTiming(metric: TimingSample["metric"], elapsedMs: number, browser = "none"): void {
  const processors = cpus();
  const sample: TimingSample = {
    schema: 1, metric, workload: timingWorkloads[metric],
    sourceSha: process.env.GITHUB_SHA ?? "local", elapsedMs, outcome: "pass",
    environment: {
      os: process.platform, arch: process.arch, kernel: release(), cpu: processors[0]?.model ?? "unknown", cores: processors.length,
      runner: process.env.RUNNER_ENVIRONMENT ?? "local", image: process.env.ImageOS ?? "unknown", imageVersion: process.env.ImageVersion ?? "unknown",
      runtime: `Bun ${process.versions.bun ?? "unknown"}; Node ${process.versions.node}`, browser,
    },
  };
  console.log(TIMING_PREFIX + JSON.stringify(sample));
}
