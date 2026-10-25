import { nextApps } from "./product-next";
import { fullstackApps } from "./product-fullstack";
import { viteApps } from "./product-vite";
import { serverApps } from "./product-servers";
import { toolApps } from "./product-tools";

export const productApps = nextApps.concat(fullstackApps, viteApps, serverApps, toolApps);
