export const networkGuardStage = "network-guard";

export class BlockedBrowserNetworkError extends Error {
  readonly urls: readonly string[];

  constructor(urls: readonly string[]) {
    const unique = Array.from(new Set(urls));
    super(`Browser attempted external network: ${unique.join(", ")}`);
    this.name = "BlockedBrowserNetworkError";
    this.urls = unique;
  }
}

type Measurement =
  | { kind: "complete" }
  | { kind: "blocked-network"; urls: readonly string[]; message: string };

export async function runProductBrowserCase(operation: () => Promise<void>): Promise<Measurement> {
  try {
    await operation();
    return { kind: "complete" };
  } catch (error) {
    if (!(error instanceof BlockedBrowserNetworkError)) throw error;
    return { kind: "blocked-network", urls: error.urls, message: error.message };
  }
}
