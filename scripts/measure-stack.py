#!/usr/bin/env python3
"""Recursion capacity per path: the deepest nesting that completes, and what one level more does.

"caught:RangeError" beyond the capacity means the engine's guard tripped; "trap" means the
host's wasm call stack ran out first. See docs/stack-limits.md.
"""
import argparse
import json
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parent.parent
MODES = ['plain', 'getter', 'proxy', 'json', 'jsonplain', 'jsonparse', 'reviver', 'parse', 'block', 'arrow', 'unary', 'power',
         'ternary', 'statement',
         'regexpnc', 'lookahead', 'proxychain', 'isarray', 'bound', 'join', 'flat', 'tostring', 'async',
         'promise', 'console']

# Each bind prefixes the name with "bound ", so deeper chains run out of memory first.
MAX = {'bound': 2000}


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
    parser.add_argument('--host', choices=['wasmtime', 'launcher', 'node'], default='wasmtime')
    parser.add_argument('--launcher', type=Path, help='bun-wasm launcher binary for --host launcher')
    parser.add_argument('--stack-kib', type=int, help='host wasm call stack (wasmtime max-wasm-stack, node --stack-size)')
    parser.add_argument('--budget-kib', type=int, help="QuickJS stack budget passed as BUN_WASM_STACK_KIB")
    parser.add_argument('--max', type=int, default=200000, help='deepest nesting tried')
    parser.add_argument('modes', nargs='*', default=MODES)
    args = parser.parse_args()
    name = {'quickjs': 'bun', 'jsc': 'bun-jsc', 'browser': 'bun-browser'}[args.engine]
    wasm = str(args.wasm or ROOT / 'dist' / (name + '.wasm'))
    preopen = str(ROOT / 'tests') + '::/'
    env = ['--env', f'BUN_WASM_STACK_KIB={args.budget_kib}'] if args.budget_kib else []
    if args.host == 'launcher':
        command = [str(args.launcher), '--wasm', wasm, '--dir', preopen] + env + ['run', '/stack-depth.js']
    elif args.host == 'node':
        flags = [f'--stack-size={args.stack_kib}'] if args.stack_kib else []
        command = ['node'] + flags + ['--no-warnings', str(ROOT / 'web/scripts/node-host.mjs'), '--wasm', wasm, '--dir', preopen] + env + ['--', 'run', '/stack-depth.js']
    else:
        flags = ['-W', f'max-wasm-stack={args.stack_kib * 1024}'] if args.stack_kib else []
        command = ['wasmtime', 'run'] + flags + env + ['--dir', preopen, wasm, 'run', '/stack-depth.js']
    results = {mode: capacity(command, mode, min(args.max, MAX.get(mode, args.max))) for mode in args.modes}
    print(json.dumps({'engine': args.engine, 'wasm': wasm, 'host': args.host, 'stack_kib': args.stack_kib,
                      'budget_kib': args.budget_kib, 'results': results}))


if __name__ == '__main__':
    main()
