import { log } from "./util";
import { dep } from "shared-dep";

log("main", dep());

export async function route(name: "home" | "about") {
  if (name === "home") {
    const { render } = await import("./pages/home");
    return render();
  }
  const mod = await import("./pages/about");
  return mod.default();
}

route("home").then(log.bind(null, "routed"));
