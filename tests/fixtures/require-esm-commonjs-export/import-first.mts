function factory() { return "import-first factory"; }
export default function original() { return "import-first default"; }
export { factory as "module.exports" };
