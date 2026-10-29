import "@xterm/xterm/css/xterm.css";
import "./style.css";

import { createElement, createRoot } from "@remix-run/component";
import { App } from "./playground/app";
import { Playground } from "./playground/playground";

const playground = new Playground(location.search);
const root = createRoot(document.querySelector<HTMLElement>("#app")!);
root.render(createElement(App, { playground }));
root.flush();
void playground.start();
