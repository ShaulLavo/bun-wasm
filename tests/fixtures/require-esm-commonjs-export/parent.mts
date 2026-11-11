import before from "./import-first.mts";
import after from "./factory.mts";
export const values = [before(), after()];
