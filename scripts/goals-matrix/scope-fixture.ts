import { Scope, type Admission } from "./scope";
import { scoped, type ScopedTransport, type Transport } from "./transport";

export async function withAdmission<T>(action: (admission: Admission) => Promise<T>, timeoutMs = 30_000): Promise<T> {
  const scope = Scope.open(timeoutMs);
  try { return await scope.run(action); }
  finally { scope.close(); }
}

export function withScoped<T>(transport: Transport, action: (page: ScopedTransport) => Promise<T>, timeoutMs = 30_000): Promise<T> {
  return withAdmission(admission => action(scoped(transport, admission)), timeoutMs);
}
