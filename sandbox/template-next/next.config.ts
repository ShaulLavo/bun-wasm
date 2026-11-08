import type { NextConfig } from "next";

const config: NextConfig = {
  experimental: { cpus: 1 },
  outputFileTracingExcludes: {
    "next-server": [
      "**/next/dist/compiled/next-server/app-page-experimental.runtime.prod.js",
      "**/next/dist/compiled/next-server/app-page-turbo-experimental.runtime.prod.js",
      "**/next/dist/compiled/next-server/app-page-turbo.runtime.prod.js",
      "**/next/dist/compiled/next-server/app-route-experimental.runtime.prod.js",
      "**/next/dist/compiled/next-server/app-route-turbo-experimental.runtime.prod.js",
      "**/next/dist/compiled/next-server/app-route-turbo.runtime.prod.js",
      "**/next/dist/compiled/next-server/pages-api-turbo.runtime.prod.js",
      "**/next/dist/compiled/next-server/pages-turbo.runtime.prod.js",
    ],
  },
};

export default config;
