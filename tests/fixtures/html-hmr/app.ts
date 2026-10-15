const message: string = "before edit";
document.querySelector("#app")!.textContent = message;
if (import.meta.hot) import.meta.hot.accept();
