import { headers, cookies } from "next/headers";

export async function context(fail = false) {
  await new Promise(resolve => setTimeout(resolve, 15));
  const header = (await headers()).get("x-next-marker") ?? "none";
  await Promise.resolve();
  const cookie = (await cookies()).get("next-marker-" + header)?.value ?? (await cookies()).get("next-marker")?.value ?? "none";
  try {
    await new Promise((resolve, reject) => setTimeout(() => fail ? reject(new Error("context rejection")) : resolve(null), 25));
  } catch {
    await Promise.resolve();
  } finally {
    await Promise.resolve();
  }
  return { pid: process.pid, header, cookie, after: (await headers()).get("x-next-marker") ?? "none", cookieAfter: (await cookies()).get("next-marker-" + header)?.value ?? (await cookies()).get("next-marker")?.value ?? "none" };
}
