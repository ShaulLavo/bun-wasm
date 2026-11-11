export let calls = 0;
export function factory() {
  calls++;
  return "factory called";
}
export default function defaultExport() { return "default called"; }
export { factory as "module.exports" };
