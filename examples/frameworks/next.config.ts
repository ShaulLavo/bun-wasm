import type { NextConfig } from "next";
import { ports } from "./ports.server";

const config: NextConfig = {
  trailingSlash: false,
  outputFileTracingRoot: process.cwd(),
  experimental: { cpus: 1 },
  async rewrites() {
    return Object.entries(ports).map(([name, port]) => ({
      source: `/api/${name}/:path*`,
      destination: `http://127.0.0.1:${port}/:path*`,
    }));
  },
};
export default config;
