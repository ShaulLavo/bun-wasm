export const nextDistTags = Object.freeze({
  requestURL: "https://registry.npmjs.org/-/package/next/dist-tags",
  registryPath: "/-/package/next/dist-tags",
  body: JSON.stringify({ latest: "15.5.6", canary: "15.5.6" }),
  provenance: "Pinned next@15.5.6 fixture metadata for the optional dev update check, not live npm tags",
});

export function isNextDistTagsRequest(url: string, method: string) {
  return method === "GET" && url === nextDistTags.requestURL;
}

export function nextDistTagsResponse(request: Request) {
  const url = new URL(request.url);
  if (request.method !== "GET" || url.hostname !== "127.0.0.1" || request.url !== url.origin + nextDistTags.registryPath) return null;
  return new Response(nextDistTags.body, { headers: {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "cross-origin-resource-policy": "cross-origin",
  } });
}
