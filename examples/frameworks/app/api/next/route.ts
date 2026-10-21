export const dynamic = "force-dynamic";
const items: string[] = [];
export function GET(request: Request) {
  return Response.json({ items, query: new URL(request.url).searchParams.get("q") }, { headers: { "x-framework": "next" } });
}
export async function POST(request: Request) {
  const body: unknown = await request.json();
  if (typeof body !== "object" || body === null || !("text" in body) || typeof body.text !== "string") {
    return Response.json({ error: "text required" }, { status: 400 });
  }
  items.push(body.text);
  return Response.json({ items }, { status: 201, headers: { "x-framework": "next" } });
}
