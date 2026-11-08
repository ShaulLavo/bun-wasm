const button = document.querySelector<HTMLButtonElement>("#increment");
const count = document.querySelector<HTMLOutputElement>("#count");
if (!button || !count) throw new Error("Counter elements missing");
button.addEventListener("click", () => { count.value = String(Number(count.value) + 1); });
