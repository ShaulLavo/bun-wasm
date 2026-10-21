import * as vm from "node:vm";
import { verifyVMContexts } from "./contract.ts";

verifyVMContexts(vm, globalThis);
console.log("VM context globals, this, Script APIs and errors preserve the Node contract");
