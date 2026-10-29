export const dynamic = "force-dynamic";
export default async function Page() {
  await Promise.resolve();
  throw new Error("NEXT-01 deliberate application error");
}
