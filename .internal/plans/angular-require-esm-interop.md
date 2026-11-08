# Angular required-module imports

Status: Approved. PR 548 depends on the exact module metadata fix in PR 542.

The actual browser guest reproduces `import_child.default is not a function`
when CommonJS requires an ES module which imports a default ES function. Bun's
external-import conversion uses Node-mode CommonJS defaults for an actual ES
namespace. Genuine Chrome Angular reaches the same path in ansi-regex.

The scoped printer hook only runs during internal esm_to_cjs conversion. It
calls the existing fresh metadata object's namespace importer. ES dependencies
keep their cached namespace; genuine CommonJS dependencies keep their complete
exports as default. Public bundler calls do not enable this hook.

The failing actual-guest control landed first in ec596406c. Both loader modes
must pass default and live named imports, namespace identity, CommonJS values
and existing metadata controls. Public bundler output before and after the
conversion must remain byte-identical. Then run all three Angular Chrome
lifecycle cells at unchanged 90000 ms bounds.

Evidence and cleanup belong to
`/work/reports/goals/astro-angular/angular/`. The parent owns independent review,
CI and merge. No goals-matrix, executor, package or Firefox changes are in scope.
