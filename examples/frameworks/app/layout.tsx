import type { ReactNode } from "react";
export default function Layout({ children }: { children: ReactNode }) {
  return <html lang="en"><body><header>Next framework routes</header>{children}</body></html>;
}
