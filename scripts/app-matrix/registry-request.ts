export function registryAccept(path: string): string {
  return path === "/-/package/next/dist-tags" ? "application/json" : "application/vnd.npm.install-v1+json";
}

export function registryReplayUrl(url: string, registry: string): string | null {
  if (url !== "https://registry.npmjs.org/-/package/next/dist-tags") return null;
  return `${registry}/-/package/next/dist-tags`;
}
