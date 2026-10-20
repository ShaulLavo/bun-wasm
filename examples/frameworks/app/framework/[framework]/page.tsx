import Controls from "./controls";
import { notFound } from "next/navigation";
import { isFramework } from "../../../names";
import { backendURL } from "../../../ports.server";

export const dynamic = "force-dynamic";
export default async function FrameworkPage({ params }: { params: Promise<{ framework: string }> }) {
  const { framework } = await params;
  if (!isFramework(framework)) notFound();
  const response = await fetch(backendURL(framework, "/items"), { cache: "no-store" });
  if (!response.ok) throw new Error(`Backend ${framework}: ${response.status}`);
  const { items } = await response.json();
  return <main><h1>{framework}</h1><p data-testid="server-items">{JSON.stringify(items)}</p><Controls key={framework} framework={framework} /></main>;
}
