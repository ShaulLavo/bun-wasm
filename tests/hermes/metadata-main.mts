import { dependencyMain } from "./tla/metadata.mts";
function nested(): boolean { return import.meta.main; }
console.log("direct metadata main", import.meta.main, !import.meta.main, nested(), dependencyMain());
