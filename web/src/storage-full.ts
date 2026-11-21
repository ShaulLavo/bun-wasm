/** Whether an error, or any error in its cause chain, says the browser's storage is full. */
export function isStorageFull(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current = error;
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    if (storageMessage(current)) return true;
    current = current && typeof current === "object" && "cause" in current ? current.cause : undefined;
  }
  return false;
}

function storageMessage(value: unknown): boolean {
  if (typeof value === "string") return /QuotaExceededError|ENOSPC|errno\s+51\b|no space left on device/i.test(value);
  if (!value || typeof value !== "object") return false;
  return "name" in value && value.name === "QuotaExceededError"
    || "message" in value && typeof value.message === "string" && storageMessage(value.message)
    || "errno" in value && value.errno === 51;
}
