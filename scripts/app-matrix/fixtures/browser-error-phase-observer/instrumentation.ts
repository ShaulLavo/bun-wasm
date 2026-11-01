export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const observer = await import("./server-observer-runtime");
    await observer.register();
  }
}
