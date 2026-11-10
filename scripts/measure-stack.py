#!/usr/bin/env python3
"""Recursion capacity per path: the deepest nesting that completes, and what one level more does.

"caught:RangeError" beyond the capacity means the engine's guard tripped; "trap" means the
host's wasm call stack ran out first. See docs/stack-limits.md.
"""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
MODES = ['plain', 'getter', 'proxy', 'json', 'jsonplain', 'jsonparse', 'reviver', 'parse', 'block', 'arrow', 'unary', 'power',
         'ternary', 'statement',
         'regexpnc', 'lookahead', 'proxychain', 'isarray', 'bound', 'join', 'flat', 'tostring', 'async',
         'promise', 'console']

# Each bind prefixes the name with "bound ", so deeper chains run out of memory first.
MAX = {'bound': 2000}

SYNTAX_MODES = {'parse', 'block', 'arrow', 'unary', 'power', 'ternary', 'statement', 'regexpnc', 'lookahead'}


def accepted(mode, outcome):
    if outcome == 'completed':
        return True
    if mode == 'console':
        return False
    return outcome == 'caught:RangeError' or (outcome == 'caught:SyntaxError' and mode in SYNTAX_MODES)


def run(command, mode, n):
    try:
        result = subprocess.run(command + [mode, str(n)], text=True, capture_output=True, timeout=120)
    except subprocess.TimeoutExpired:
        return 'timeout'
    if result.returncode != 0:
        return 'trap'
    lines = result.stdout.splitlines()
    outcomes = [line for line in lines if re.match(r'^(completed|caught) ', line)]
    if len(outcomes) != 1:
        return 'invalid-output'
    line = outcomes[0]
    if 'continued' not in lines or lines.index('continued') <= lines.index(line):
        return 'missing-continuation'
    if line == f'completed {mode} {n}':
        return 'completed'
    caught = re.fullmatch(r'caught (\w+) (\w+) (\d+) (.*)', line)
    if not caught or caught[1] != mode or int(caught[3]) != n:
        return 'invalid-output'
    outcome = f'caught:{caught[2]}'
    return outcome if accepted(mode, outcome) else f'unexpected:{caught[2]}'


def capacity(command, mode, high):
    failures = []

    def trial(depth):
        outcome = run(command, mode, depth)
        if not accepted(mode, outcome):
            failures.append({'depth': depth, 'outcome': outcome})
        return outcome

    if trial(high) == 'completed':
        return {'completed_at_max': high, 'failures': failures}
    low = 0
    while low + 1 < high:
        middle = (low + high) // 2
        if trial(middle) == 'completed':
            low = middle
        else:
            high = middle
    return {'capacity': low, 'beyond': trial(low + 1), 'failures': failures}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--engine', choices=['quickjs', 'jsc', 'browser'], default='quickjs')
    parser.add_argument('--wasm', type=Path, help='module to measure (default: dist/ for the engine)')
    parser.add_argument('--host', choices=['launcher', 'node'], help='default: launcher for QuickJS/JSC, node for browser')
    parser.add_argument('--launcher', type=Path, default=Path(os.environ.get('BUN_WASM_LAUNCHER', str(Path(os.environ.get('CARGO_TARGET_DIR', '/work/tmp/bun-wasm-target')) / 'release/bun-wasm'))), help='bun-wasm launcher binary for --host launcher')
    parser.add_argument('--stack-kib', type=int, help="host wasm call stack (native launcher, or the Node host's Worker stack)")
    parser.add_argument('--budget-kib', type=int, help="QuickJS stack budget passed as BUN_WASM_STACK_KIB")
    parser.add_argument('--max', type=int, default=200000, help='deepest nesting tried')
    parser.add_argument('modes', nargs='*', default=MODES)
    args = parser.parse_args()
    args.modes = list(dict.fromkeys(args.modes))
    if args.max <= 0:
        parser.error('--max must be positive')
    if any(mode not in MODES for mode in args.modes):
        parser.error('unknown stack mode')
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
    if args.host == 'launcher':
        command = [str(args.launcher), '--wasm', wasm, '--dir', preopen] + env + ['--', 'run', '/stack-depth.js']
    elif args.host == 'node':
        # The guest runs in node-host.mjs's Worker, whose stack --stack-mb sets.
        flags = ['--stack-mb', f'{args.stack_kib / 1024:g}'] if args.stack_kib else []
        command = ['node', '--no-warnings', str(ROOT / 'web/scripts/node-host.mjs')] + flags + ['--wasm', wasm, '--dir', preopen] + env + ['--', 'run', '/stack-depth.js']
    results = {mode: capacity(command, mode, min(args.max, MAX.get(mode, args.max))) for mode in args.modes}
    print(json.dumps({'engine': args.engine, 'wasm': wasm, 'host': args.host, 'stack_kib': args.stack_kib,
                      'budget_kib': args.budget_kib, 'results': results}))
    return int(any(row['failures'] for row in results.values()))


if __name__ == '__main__':
    sys.exit(main())
