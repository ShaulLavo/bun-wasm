import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

interface RequestCase {
  path: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  status: number;
  json?: Record<string, string | number>;
}
export interface ServerResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}
export interface ServerObservation {
  request: RequestCase;
  response: ServerResponse;
}
export type ServerRequest = (request: RequestCase) => Promise<ServerResponse>;

export function serverCases(framework: string, token: string = randomUUID()): RequestCase[] {
  const headers = { "x-matrix-token": token };
  const first = encodeURIComponent(`first-${token}`);
  const second = encodeURIComponent(`second-${token}`);
  return [
    { path: `items/${first}?tag=${encodeURIComponent(`one ${token}`)}`, method: "GET", headers, status: 200, json: { framework, id: `first-${token}`, tag: `one ${token}` } },
    { path: `items/${second}?tag=two`, method: "GET", headers, status: 200, json: { framework, id: `second-${token}`, tag: "two" } },
    { path: `items/${second}`, method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ value: token, count: 7 }), status: 201, json: { framework, id: `second-${token}`, value: token, count: 7 } },
    { path: `items/${first}`, method: "POST", headers: { ...headers, "content-type": "application/json" }, body: "{", status: 400 },
    { path: `missing-${token}`, method: "GET", headers, status: 404 },
    { path: `items/${first}`, method: "DELETE", headers, status: 404 },
  ];
}

export function assertServerResponse(framework: string, request: RequestCase, response: ServerResponse): void {
  const label = `${request.method} ${request.path}`;
  if (response.status !== request.status) throw new Error(`${label}: expected HTTP ${request.status}, got ${response.status}: ${response.body.slice(0, 300)}`);
  if (response.headers["x-matrix-framework"] !== framework) throw new Error(`${label}: missing framework middleware header`);
  if (response.headers["x-matrix-token"] !== request.headers["x-matrix-token"]) throw new Error(`${label}: middleware did not echo request challenge`);
  if (!request.json) return;
  if (!response.headers["content-type"]?.includes("application/json")) throw new Error(`${label}: expected JSON content type`);
  const actual: unknown = JSON.parse(response.body);
  if (!isDeepStrictEqual(actual, request.json)) throw new Error(`${label}: JSON mismatch: ${response.body}`);
}

export async function verifyServerContract(framework: string, request: ServerRequest, record: (observation: ServerObservation) => void = () => {}): Promise<string> {
  const cases = serverCases(framework);
  for (const expected of cases) {
    const response = await request(expected);
    record({ request: expected, response });
    assertServerResponse(framework, expected, response);
  }
  return `${cases.length} request checks: dynamic route/query, JSON POST 201, malformed JSON 400, missing route and wrong method 404, middleware headers`;
}
