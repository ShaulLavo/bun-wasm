import "@xterm/xterm/css/xterm.css";
import "./style.css";

import { createElement, createRoot } from "@remix-run/component";
import { App } from "./app";
import { Sandbox } from "./sandbox";

const sandbox = new Sandbox(location.search);
const root = createRoot(document.querySelector<HTMLElement>("#app")!);
root.render(createElement(App, { sandbox }));
root.flush();
sandbox.start();
