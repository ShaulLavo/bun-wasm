import type { NextConfig } from "next";

const config: NextConfig = { outputFileTracingRoot: process.cwd(), agentRules: false, experimental: { cpus: 1 } };
export default config;
