export type QuotaAction = "cap" | "reset";
export type QuotaControl = (action: QuotaAction) => Promise<boolean>;
type QuotaReply =
  | { kind: "idle-quota-result"; active: boolean }
  | { kind: "idle-quota-result"; error: string };

// Waffle's public provider protocol uses unnumbered worker messages.
export function forwardQuotaRequest(
  data: unknown,
  control: QuotaControl,
  reply: (result: QuotaReply) => void,
): boolean {
  if (!data || typeof data !== "object" || !("idleQuota" in data)) return false;
  const action = data.idleQuota;
  if (action !== "cap" && action !== "reset") return false;
  void Promise.resolve().then(() => control(action)).then(
    active => reply({ kind: "idle-quota-result", active }),
    error => reply({ kind: "idle-quota-result", error: String(error) }),
  );
  return true;
}

export function requestQuota(action: QuotaAction): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const receive = ({ data }: MessageEvent<QuotaReply>) => {
      if (data?.kind !== "idle-quota-result") return;
      globalThis.removeEventListener("message", receive);
      if ("error" in data) reject(new Error(data.error));
      else resolve(data.active);
    };
    globalThis.addEventListener("message", receive);
    globalThis.postMessage({ idleQuota: action });
  });
}
