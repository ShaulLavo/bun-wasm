import { log } from "./util";
log("admin");
export const lazyAbout = () => import("./pages/about");
