import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { approveAssignedJob, type GitHubApi, type Session } from "./policy.ts";

export async function createGuard(options: { session: Session; api: GitHubApi; stopVm: () => Promise<void>; timeoutMs?: number }) {
  const token = randomBytes(32).toString("hex");
  let stopped = false;
  let approved = false;
  const evidence = { authenticated: false, apiChecked: false, approved: false, decision: "pending" };
  async function deny(reason = "policy"): Promise<void> {
    if (stopped) return;
    stopped = true;
    evidence.decision = reason;
    clearTimeout(timer);
    await options.stopVm();
    server.closeAllConnections();
    server.close();
  }
  const server = createServer((request, response) => {
    handle(request, response).catch(() => deny()).catch(() => { server.closeAllConnections(); server.close(); });
  });
  const timer = setTimeout(() => { deny("timeout").catch(() => { server.closeAllConnections(); server.close(); }); }, options.timeoutMs ?? 120_000);

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const authorization = request.headers.authorization ?? "";
    const expected = `Bearer ${token}`;
    if (stopped || approved || request.method !== "POST" || request.url !== "/approve" || authorization.length !== expected.length || !timingSafeEqual(Buffer.from(authorization), Buffer.from(expected))) return deny("authentication");
    evidence.authenticated = true;
    let body = "";
    for await (const chunk of request) {
      body += chunk.toString();
      if (body.length > 1024) return deny();
    }
    const hint: unknown = JSON.parse(body);
    if (typeof hint !== "object" || hint === null || !("runId" in hint) || !("attempt" in hint) || hint.runId !== String(options.session.runId) || hint.attempt !== String(options.session.attempt)) return deny();
    response.once("close", () => { if (!response.writableFinished && !approved) deny("transport").catch(() => undefined); });
    evidence.apiChecked = true;
    await approveAssignedJob(options.api, options.session);
    if (stopped || response.destroyed) return deny();
    approved = true;
    evidence.approved = true;
    evidence.decision = "approved";
    clearTimeout(timer);
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"approved":true}');
  }

  await new Promise<void>((resolveListen, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolveListen); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing VM guard listener");
  return {
    url: `http://10.0.2.2:${address.port}/approve`, token, evidence,
    close: async () => { clearTimeout(timer); stopped = true; server.closeAllConnections(); await new Promise<void>(resolveClose => server.close(() => resolveClose())); },
  };
}
