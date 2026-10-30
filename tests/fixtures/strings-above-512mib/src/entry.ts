import { greeting, shout } from "./latin1";
import { 名前, label } from "./utf8";
import { emoji, pairs } from "./utf16";
console.log(shout(greeting), 名前, label(3), emoji, pairs.join(","));
