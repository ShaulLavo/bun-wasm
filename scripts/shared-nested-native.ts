import { runProfileFixtures } from './native-profile-fixtures.ts';
import { selectChecks } from './test-checks.ts';

if (import.meta.main) {
  const [program, launcher] = process.argv.slice(2);
  if (!program || !launcher) throw new Error('Usage: source env.sh; bun scripts/shared-nested-native.ts GROUP_PROGRAM NATIVE_LAUNCHER');
  const env = { ...process.env, BUN_WASM_PROFILE_PROGRAM: program, BUN_WASM_LAUNCHER: launcher, BUN_WASM_TRACE: '1' };
  console.log(JSON.stringify({ kind: 'real-quickjs-shared-group-native', results: runProfileFixtures(selectChecks('native', undefined, 'shared-group'), env) }, null, 2));
}
