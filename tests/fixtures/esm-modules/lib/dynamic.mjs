export default "dynamic module";
export const loadedFrom = import.meta.file;
console.log("dynamic module evaluated once, main =", import.meta.main);
