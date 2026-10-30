import "./App.css";

const root = document.querySelector<HTMLElement>("#root")!;
let count = import.meta.hot ? import.meta.hot.data.count ?? 0 : 0;
root.innerHTML = `
  <h1>Hello from vanilla TypeScript</h1>
  <p class="tagline">Vite hot reload works without a framework.</p>
  <button class="counter">count is ${count}</button>
  <p class="hint">Edit src/main.ts. The count lives in import.meta.hot.data.</p>
`;
const button = root.querySelector<HTMLButtonElement>("button")!;
button.onclick = () => { button.textContent = `count is ${++count}`; };

if (import.meta.hot) {
  import.meta.hot.accept();
  import.meta.hot.dispose((data) => { data.count = count; });
}
