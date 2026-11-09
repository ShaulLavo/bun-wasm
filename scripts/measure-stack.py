#!/usr/bin/env python3
"""Recursion capacity per path: the deepest nesting that completes, and what one level more does.

"caught:RangeError" beyond the capacity means the engine's guard tripped; "trap" means the
host's wasm call stack ran out first. See docs/stack-limits.md.
"""
import argparse
import contextlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent.parent
MODES = ['plain', 'getter', 'proxy', 'json', 'jsonplain', 'jsonparse', 'reviver', 'parse', 'block', 'arrow', 'unary', 'power',
         'ternary', 'statement',
         'regexpnc', 'lookahead', 'proxychain', 'isarray', 'bound', 'join', 'flat', 'tostring', 'async',
         'promise', 'console', 'require']

# Each bind prefixes the name with "bound ", so deeper chains run out of memory first.
# Each require level is a generated file, so the chain stays far above any real package depth and no higher.
MAX = {'bound': 2000, 'require': 512}
REQUIRE_SCRATCH = '/stack-depth-scratch'
REQUIRE_LEAF_ROOT = '/stack-depth-leaf'


def require_chain(stack, args, parser):
    """Guest flags for the require mode: a private scratch preopen, removed when the measurement ends."""
    if (args.leaf is None) != (args.leaf_root is None):
        parser.error('--leaf and --leaf-root go together')
    if 'require' not in args.modes:
        if args.leaf:
            parser.error('--leaf applies to the require mode')
        return []
    scratch = stack.enter_context(tempfile.TemporaryDirectory(
        prefix='bun-wasm-stack-require-', dir=os.environ.get('BUN_WASM_SCRATCH_ROOT') or tempfile.gettempdir()))
    flags = ['--dir', f'{scratch}::{REQUIRE_SCRATCH}', '--env', f'STACK_DEPTH_DIR={REQUIRE_SCRATCH}']
    if not args.leaf:
        return flags
    return flags + ['--dir', f'{args.leaf_root.absolute()}::{REQUIRE_LEAF_ROOT}',
                    '--env', f'STACK_DEPTH_LEAF={REQUIRE_LEAF_ROOT}/{args.leaf}']


def run(command, mode, n):
    result = subprocess.run(command + [mode, str(n)], text=True, capture_output=True, timeout=120)
    match = re.search(r'^(completed|caught) \w+ (?:(\w+) )?\d+', result.stdout, re.M)
    if result.returncode == 0 and match and 'continued' in result.stdout:
        return 'completed' if match[1] == 'completed' else f'caught:{match[2]}'
    output = (result.stderr + result.stdout).lower()
    if 'call stack' in output or 'stack overflow' in output or 'stack exhausted' in output:
        return 'trap'
    raise RuntimeError(f'{mode} {n}: exit {result.returncode}\n{result.stdout[-1000:]}\n{result.stderr[-2000:]}')


def capacity(command, mode, high):
    if mode == 'require':
        baseline = run(command, mode, 0)
        if baseline != 'completed':
            return {'refused_at_zero': baseline}
    if run(command, mode, high) == 'completed':
        return {'completed_at_max': high}
    low = 0
    while low + 1 < high:
        middle = (low + high) // 2
        if run(command, mode, middle) == 'completed':
            low = middle
        else:
            high = middle
    return {'capacity': low, 'beyond': run(command, mode, low + 1)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--engine', choices=['quickjs', 'jsc', 'browser'], default='quickjs')
    parser.add_argument('--wasm', type=Path, help='module to measure (default: dist/ for the engine)')
    parser.add_argument('--host', choices=['launcher', 'node'], help='default: launcher for QuickJS/JSC, node for browser')
    parser.add_argument('--launcher', type=Path, default=Path(os.environ.get('BUN_WASM_LAUNCHER', str(Path(os.environ.get('CARGO_TARGET_DIR', '/work/tmp/bun-wasm-target')) / 'release/bun-wasm'))), help='bun-wasm launcher binary for --host launcher')
    parser.add_argument('--stack-kib', type=int, help="host wasm call stack (native launcher, or the Node host's Worker stack)")
    parser.add_argument('--budget-kib', type=int, help="QuickJS stack budget passed as BUN_WASM_STACK_KIB")
    parser.add_argument('--max', type=int, default=200000, help='deepest nesting tried')
    parser.add_argument('--leaf-root', type=Path, help='host project directory, the one holding node_modules, that the require chain ends in')
    parser.add_argument('--leaf', help='module path inside --leaf-root that the last require level loads, such as node_modules/prompts/index.js')
    parser.add_argument('modes', nargs='*', default=MODES)
    args = parser.parse_args()
    args.host = args.host or ('node' if args.engine == 'browser' else 'launcher')
    if args.engine == 'browser' and args.host != 'node':
        parser.error('--engine browser requires --host node')
    if args.stack_kib is not None and args.stack_kib <= 0:
        parser.error('--stack-kib must be positive')
    if args.host == 'launcher' and args.stack_kib is not None:
        os.environ['BUN_WASM_HOST_STACK_KIB'] = str(args.stack_kib)
    name = {'quickjs': 'bun', 'jsc': 'bun-jsc', 'browser': 'bun-browser'}[args.engine]
    wasm = str(args.wasm or ROOT / 'dist' / (name + '.wasm'))
    preopen = str(ROOT / 'tests') + '::/'
    env = ['--env', 'PWD=/'] + (['--env', f'BUN_WASM_STACK_KIB={args.budget_kib}'] if args.budget_kib else [])
    with contextlib.ExitStack() as stack:
        env += require_chain(stack, args, parser)
        if args.host == 'launcher':
            command = [str(args.launcher), '--wasm', wasm, '--dir', preopen] + env + ['--', 'run', '/stack-depth.js']
        elif args.host == 'node':
            # The guest runs in node-host.mjs's Worker, whose stack --stack-mb sets.
            flags = ['--stack-mb', f'{args.stack_kib / 1024:g}'] if args.stack_kib else []
            command = ['node', '--no-warnings', str(ROOT / 'web/scripts/node-host.mjs')] + flags + ['--wasm', wasm, '--dir', preopen] + env + ['--', 'run', '/stack-depth.js']
        results = {mode: capacity(command, mode, min(args.max, MAX.get(mode, args.max))) for mode in args.modes}
    print(json.dumps({'engine': args.engine, 'wasm': wasm, 'host': args.host, 'stack_kib': args.stack_kib,
                      'budget_kib': args.budget_kib, 'leaf': args.leaf, 'results': results}))


if __name__ == '__main__':
    main()
