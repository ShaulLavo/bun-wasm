import { context } from "../../context";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  return Response.json(await context(new URL(request.url).searchParams.has("fail")));
}
export async function POST(request: Request) {
  const body: unknown = await request.json();
  await Promise.resolve();
  return Response.json({ ...await context(true), body }, { status: 201 });
}
