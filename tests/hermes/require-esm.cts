const namespace = require("./tla/sync.mts");
console.log("require ESM", namespace.default, namespace.count);
namespace.increment();
import("./tla/sync.mts").then(imported => {
  console.log("shared ESM cache", namespace.identity === imported.identity, imported.count);
});
