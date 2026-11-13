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
import sys
import tempfile

ROOT = Path(__file__).resolve().parent.parent
# The parser chains of tests/stack-depth.js: six shapes, two parser passes, two source widths.
CHAIN_MODES = [f'chain{kind}{parser_pass}{width}' for kind in ('Assign', 'Conditional', 'Block', 'Call', 'Function', 'While')
               for parser_pass in ('Compile', 'Call') for width in ('8', '16')]
MODES = ['plain', 'getter', 'computedgetter', 'ajvnames', 'proxy', 'json', 'jsonplain', 'jsonparse', 'reviver', 'parse', 'block', 'arrow', 'unary', 'power',
         'ternary', 'statement', 'awaitchain',
         'regexpnc', 'lookahead', 'proxychain', 'isarray', 'bound', 'boundcall', 'join', 'flat', 'tostring', 'async',
         'promise', 'console', 'require'] + CHAIN_MODES
# Modes that need an input the default sweep does not have: `ajv` reads an installed package.
OPTIONAL_MODES = ['ajv']

# Each bind prefixes the name with "bound ", so deeper chains run out of memory first.
# Each require level is a generated file, so the chain stays far above any real package depth and no higher.
# A parser chain stays far past any budget's capacity and small enough to remain a parser test.
# The Ajv walks merge one name set per level, so their depth stays where that work is small.
MAX = {'bound': 2000, 'require': 512, 'ajvnames': 4096, 'ajv': 4096, **{mode: 4096 for mode in CHAIN_MODES}}
REQUIRE_SCRATCH = '/stack-depth-scratch'
REQUIRE_LEAF_ROOT = '/stack-depth-leaf'
AJV_CODEGEN_ROOT = '/stack-depth-ajv'
# Enough of a trap's backtrace to name its recursion cycle.
STDERR_KEPT = 4000


def ajv_codegen(args, parser):
    """Guest flags for the ajv mode: a preopen of the installed package's compile/codegen directory."""
    if ('ajv' in args.modes) != (args.ajv_codegen is not None):
        parser.error('--ajv-codegen and the ajv mode go together')
    if args.ajv_codegen is None:
        return []
    if not (args.ajv_codegen / 'index.js').is_file():
        parser.error('--ajv-codegen needs the directory holding ajv/dist/compile/codegen/index.js')
    return ['--dir', f'{args.ajv_codegen.absolute()}::{AJV_CODEGEN_ROOT}', '--env', f'STACK_DEPTH_AJV_CODEGEN={AJV_CODEGEN_ROOT}/index.js']


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


SYNTAX_MODES = {'parse', 'block', 'arrow', 'unary', 'power', 'ternary', 'statement', 'awaitchain', 'regexpnc', 'lookahead', *CHAIN_MODES}


def accepted(mode, outcome):
    if outcome == 'completed':
        return True
    if mode == 'console':
        return False
    return outcome == 'caught:RangeError' or (outcome == 'caught:SyntaxError' and mode in SYNTAX_MODES)


def kept(stream):
    """The end of a child's stream as text, whether or not the child was cut off."""
    text = stream.decode(errors='replace') if isinstance(stream, bytes) else (stream or '')
    return text[-STDERR_KEPT:]


def run(command, mode, n, attempts):
    """One attempt's outcome. Every attempt is recorded with its exit status, timeout and stderr."""
    try:
        result = subprocess.run(command + [mode, str(n)], text=True, capture_output=True, timeout=120)
    except subprocess.TimeoutExpired as expired:
        attempts.append({'depth': n, 'outcome': 'timeout', 'status': None, 'timed_out': True, 'stderr': kept(expired.stderr)})
        return 'timeout'
    outcome = classify(result, mode, n)
    attempts.append({'depth': n, 'outcome': outcome, 'status': result.returncode, 'timed_out': False, 'stderr': kept(result.stderr)})
    return outcome


def classify(result, mode, n):
    if result.returncode != 0:
        return 'trap'
    lines = result.stdout.splitlines()
    outcomes = [line for line in lines if re.match(r'^(completed|caught) ', line)]
    if len(outcomes) != 1:
        return 'invalid-output'
    line = outcomes[0]
    if lines.count('continued') > 1:
        return 'invalid-output'
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
    attempts = []

    def trial(depth, require_completion=False):
        outcome = run(command, mode, depth, attempts)
        if not accepted(mode, outcome) or (require_completion and outcome != 'completed'):
            failures.append({'depth': depth, 'outcome': outcome})
        return outcome

    def row(result):
        return {**result, 'failures': failures, 'attempts': attempts}

    if mode == 'require':
        baseline = trial(0, require_completion=True)
        if baseline != 'completed':
            return row({'refused_at_zero': baseline})
    if trial(high) == 'completed':
        return row({'completed_at_max': high})
    low = 0
    while low + 1 < high:
        middle = (low + high) // 2
        if trial(middle) == 'completed':
            low = middle
        else:
            high = middle
    return row({'capacity': low, 'beyond': trial(low + 1)})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--engine', choices=['quickjs', 'jsc', 'browser'], default='quickjs')
    parser.add_argument('--wasm', type=Path, help='module to measure (default: dist/ for the engine)')
    parser.add_argument('--host', choices=['launcher', 'node'], help='default: launcher for QuickJS/JSC, node for browser')
    parser.add_argument('--launcher', type=Path, default=Path(os.environ.get('BUN_WASM_LAUNCHER', str(Path(os.environ.get('CARGO_TARGET_DIR', '/work/tmp/bun-wasm-target')) / 'release/bun-wasm'))), help='bun-wasm launcher binary for --host launcher')
    parser.add_argument('--stack-kib', type=int, help="host wasm call stack (native launcher, or the Node host's Worker stack)")
    parser.add_argument('--budget-kib', type=int, help="QuickJS stack budget passed as BUN_WASM_STACK_KIB")
    parser.add_argument('--parser-reserve', help="passed unchanged as BUN_WASM_JSC_PARSER_RESERVE; the JSC guest validates it")
    parser.add_argument('--max', type=int, default=200000, help='deepest nesting tried')
    parser.add_argument('--leaf-root', type=Path, help='host project directory, the one holding node_modules, that the require chain ends in')
    parser.add_argument('--leaf', help='module path inside --leaf-root that the last require level loads, such as node_modules/prompts/index.js')
    parser.add_argument('--ajv-codegen', type=Path, help='host directory holding an installed ajv/dist/compile/codegen/index.js, for the ajv mode')
    parser.add_argument('modes', nargs='*', default=MODES)
    args = parser.parse_args()
    args.modes = list(dict.fromkeys(args.modes))
    if args.max <= 0:
        parser.error('--max must be positive')
    if any(mode not in MODES + OPTIONAL_MODES for mode in args.modes):
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
    if args.parser_reserve is not None:
        env += ['--env', f'BUN_WASM_JSC_PARSER_RESERVE={args.parser_reserve}']
    env += ajv_codegen(args, parser)
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
                      'budget_kib': args.budget_kib, 'parser_reserve': args.parser_reserve, 'leaf': args.leaf, 'results': results}))
    return int(any(row['failures'] for row in results.values()))


if __name__ == '__main__':
    sys.exit(main())
