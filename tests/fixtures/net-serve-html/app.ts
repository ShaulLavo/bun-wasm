import { message } from "./message";
import icon from "./icon.png";
const app: HTMLElement | null = document.querySelector("#app");
if (app) { app.textContent = message; app.dataset.icon = icon; }
