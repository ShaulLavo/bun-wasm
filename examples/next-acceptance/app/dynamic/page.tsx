import { context } from "../context";

export const dynamic = "force-dynamic";
export default async function Page() {
  const values = await context(true);
  return <main><h1>server-original</h1><pre data-context>{JSON.stringify(values)}</pre></main>;
}
